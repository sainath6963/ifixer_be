#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

backup_directory="${1:-}"
[[ "$backup_directory" == /* && "$backup_directory" != "/" && -d "$backup_directory" ]] || {
  echo "Pass one absolute backup directory" >&2
  exit 1
}

for required_file in mongodb.archive.gz media.tar.gz manifest.env SHA256SUMS; do
  [[ -s "$backup_directory/$required_file" ]] || {
    echo "Backup file is missing or empty: $required_file" >&2
    exit 1
  }
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$backup_directory" && sha256sum -c SHA256SUMS)
else
  (cd "$backup_directory" && shasum -a 256 -c SHA256SUMS)
fi

temporary_directory="$(mktemp -d)"
target_database="${RESTORE_VERIFY_DATABASE:-}"
restore_uri="${RESTORE_VERIFY_MONGODB_URI:-}"
restore_started=false
cleanup() {
  rm -rf -- "$temporary_directory"
  if [[ \
    "$restore_started" == "true" && \
    "${VERIFY_KEEP_DATABASE:-false}" != "true" \
  ]]; then
    mongosh "$restore_uri" --quiet --eval \
      "db.getSiblingDB('${target_database}').dropDatabase();" >/dev/null
  fi
}
trap cleanup EXIT

while IFS= read -r entry; do
  if [[ \
    "$entry" == /* || \
    "$entry" == ".." || \
    "$entry" == ../* || \
    "$entry" == */../* || \
    "$entry" == */.. \
  ]]; then
    echo "Unsafe media archive entry: $entry" >&2
    exit 1
  fi
done < <(tar -tzf "$backup_directory/media.tar.gz")
tar -xzf "$backup_directory/media.tar.gz" -C "$temporary_directory"

source_database="$(sed -n 's/^SOURCE_DATABASE=//p' "$backup_directory/manifest.env")"
[[ "$source_database" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || {
  echo "Backup manifest has an invalid source database" >&2
  exit 1
}

if [[ -z "$restore_uri" && -z "$target_database" ]]; then
  echo "Archive and media extraction verification passed."
  echo "Set RESTORE_VERIFY_MONGODB_URI and RESTORE_VERIFY_DATABASE for an isolated database restore test."
  exit 0
fi

[[ -n "$restore_uri" && "$target_database" =~ ^rich_culture_restore_verify_[A-Za-z0-9_-]+$ ]] || {
  echo "Restore verification requires an isolated database named rich_culture_restore_verify_*" >&2
  exit 1
}
command -v mongorestore >/dev/null 2>&1 || {
  echo "Required command is unavailable: mongorestore" >&2
  exit 1
}
command -v mongosh >/dev/null 2>&1 || {
  echo "Required command is unavailable: mongosh" >&2
  exit 1
}

restore_started=true
mongorestore \
  --uri="$restore_uri" \
  --archive="$backup_directory/mongodb.archive.gz" \
  --gzip \
  --drop \
  --nsFrom="${source_database}.*" \
  --nsTo="${target_database}.*"

mongosh "$restore_uri" --quiet --eval "
  const restored = db.getSiblingDB('${target_database}');
  const collections = restored.getCollectionNames();
  if (collections.length === 0) throw new Error('Restore verification database is empty');
  const migrationCount = restored.getCollection('database_migrations').countDocuments({});
  if (migrationCount === 0) throw new Error('Migration history is missing after restore');
  print(JSON.stringify({ database: '${target_database}', collections: collections.length, migrationCount }));
"

echo "Isolated MongoDB restore and media extraction verification passed."
