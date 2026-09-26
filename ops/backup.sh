#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $1" >&2
    exit 1
  }
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || {
    echo "Required environment variable is missing: $name" >&2
    exit 1
  }
}

safe_absolute_directory() {
  local value="$1"
  [[ "$value" == /* && "$value" != "/" && "$value" != "$HOME" ]] || {
    echo "Unsafe directory: $value" >&2
    exit 1
  }
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

require_command mongodump
require_command tar
require_command find
require_value MONGODB_URI
require_value BACKUP_DATABASE_NAME
require_value MEDIA_STORAGE_ROOT
require_value BACKUP_ROOT
safe_absolute_directory "$MEDIA_STORAGE_ROOT"
safe_absolute_directory "$BACKUP_ROOT"

[[ "$BACKUP_DATABASE_NAME" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || {
  echo "BACKUP_DATABASE_NAME is invalid" >&2
  exit 1
}
[[ -d "$MEDIA_STORAGE_ROOT" ]] || {
  echo "Media storage root does not exist: $MEDIA_STORAGE_ROOT" >&2
  exit 1
}

retention_days="${BACKUP_RETENTION_DAYS:-14}"
[[ "$retention_days" =~ ^[0-9]+$ && "$retention_days" -ge 1 && "$retention_days" -le 3650 ]] || {
  echo "BACKUP_RETENTION_DAYS must be between 1 and 3650" >&2
  exit 1
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_name="rich-culture-${timestamp}"
final_directory="${BACKUP_ROOT}/${backup_name}"
staging_directory="${BACKUP_ROOT}/.staging-${backup_name}-${RANDOM}"
safe_absolute_directory "$staging_directory"
[[ ! -e "$final_directory" ]] || {
  echo "Backup already exists: $final_directory" >&2
  exit 1
}

mkdir -p "$BACKUP_ROOT"
mkdir "$staging_directory"
cleanup() {
  if [[ -d "$staging_directory" ]]; then
    rm -rf -- "$staging_directory"
  fi
}
trap cleanup EXIT

mongodump \
  --uri="$MONGODB_URI" \
  --db="$BACKUP_DATABASE_NAME" \
  --archive="$staging_directory/mongodb.archive.gz" \
  --gzip

tar \
  --exclude='./.staging' \
  -C "$MEDIA_STORAGE_ROOT" \
  -czf "$staging_directory/media.tar.gz" \
  .

{
  echo "BACKUP_FORMAT_VERSION=1"
  echo "CREATED_AT=${timestamp}"
  echo "SOURCE_DATABASE=${BACKUP_DATABASE_NAME}"
  echo "APP_RELEASE=${APP_RELEASE:-unknown}"
} >"$staging_directory/manifest.env"

(
  cd "$staging_directory"
  checksum mongodb.archive.gz
  checksum media.tar.gz
  checksum manifest.env
) >"$staging_directory/SHA256SUMS"

mv "$staging_directory" "$final_directory"
trap - EXIT
echo "Backup completed: $final_directory"

if [[ "${BACKUP_PRUNE_CONFIRM:-}" == "DELETE_EXPIRED_RICH_CULTURE_BACKUPS" ]]; then
  while IFS= read -r -d '' candidate; do
    candidate_name="$(basename "$candidate")"
    if [[ "$candidate_name" =~ ^rich-culture-[0-9]{8}T[0-9]{6}Z$ ]]; then
      rm -rf -- "$candidate"
      echo "Deleted expired backup: $candidate"
    fi
  done < <(
    find "$BACKUP_ROOT" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'rich-culture-*' \
      -mtime "+$retention_days" \
      -print0
  )
else
  echo "Retention prune skipped; set BACKUP_PRUNE_CONFIRM=DELETE_EXPIRED_RICH_CULTURE_BACKUPS to enable it."
fi
