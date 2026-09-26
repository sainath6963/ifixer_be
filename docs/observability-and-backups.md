# Observability and Backup Operations

This runbook covers the self-hosted production foundation for metrics, readiness, alerting, MongoDB/media backups, and restore drills. It does not send data to a third party. Prometheus, Grafana, or another monitoring system can scrape the protected endpoint from the private VPS network.

## Production configuration

Set these values in the protected backend runtime environment:

```dotenv
APP_RELEASE=2026.08.20-1
METRICS_ENABLED=true
METRICS_BEARER_TOKEN=<at-least-32-random-characters>
MEDIA_MIN_FREE_BYTES=2147483648
```

- `APP_RELEASE` must identify the immutable deployment. Production rejects `local`.
- Production requires metrics to be enabled and protected by a bearer token.
- Rotate `METRICS_BEARER_TOKEN` like any other production secret. Never place it in frontend variables, source control, URLs, or logs.
- `MEDIA_MIN_FREE_BYTES` makes readiness fail before the local media filesystem is full. Size it above the largest expected upload burst plus operating headroom.

## Health and metrics endpoints

- `GET /api/v1/health/live` proves only that the Node.js process can answer.
- `GET /api/v1/health/ready` checks MongoDB, Redis, media-directory access, and the configured media free-space floor but returns only sanitized public status. Authenticated admins can view detailed results at `GET /api/v1/admin/health/ready`.
- `GET /api/v1/metrics` returns Prometheus text only when metrics are enabled and the exact bearer token is supplied.

Example private-network scrape:

```bash
curl --fail --silent \
  --header "Authorization: Bearer ${RICH_CULTURE_METRICS_TOKEN}" \
  https://store.example.com/api/v1/metrics
```

Do not expose metrics broadly to the internet. Restrict the route at the firewall or reverse proxy to the monitoring host in addition to the application token. The endpoint deliberately uses controller and handler names rather than raw URLs, customer IDs, order IDs, or request IDs, keeping label cardinality bounded.

The endpoint reports:

- release and process uptime/memory;
- HTTP request count and latency histogram by bounded handler/status labels;
- BullMQ waiting, active, delayed, and failed jobs plus worker outcome/latency;
- payment/refund reconciliation outcomes and current record states;
- notification/outbox states and notification sweep outcomes;
- current delivery exceptions and overdue exchange reservations;
- media-filesystem free bytes and metric-collection failures.

Collection errors do not make the scrape endpoint fail completely. Alert on `rich_culture_metrics_collection_errors_total`; a rising value means one group of operational gauges may be stale.

## Initial alert policy

Tune thresholds from production traffic and record an owner and response link for every alert. A sensible starting policy is:

- readiness non-200 for 2 minutes: page the operator;
- sustained HTTP 5xx rate or a sharp p95 latency increase for 5 minutes: page the operator;
- `rich_culture_queue_jobs{state="failed"} > 0`, growing waiting backlog, or recent failed worker runs: investigate immediately;
- any reconciliation `outcome="failed"`, failed refunds, or payment attempts stuck outside terminal states: payment-operations alert;
- dead outbox/notification records or a rising notification failure counter: customer-communication alert;
- overdue exchange reservations or delivery exceptions above the accepted operational baseline: fulfillment alert;
- `rich_culture_media_storage_free_bytes` approaching `MEDIA_MIN_FREE_BYTES`: urgent capacity alert before readiness fails;
- no successful scrape, stale `rich_culture_metrics_last_scrape_timestamp_seconds`, MongoDB replication lag, Redis failure, or abnormal process memory growth: infrastructure alert.

Metrics describe application state; they do not replace Razorpay settlement reconciliation, MongoDB monitoring, host CPU/disk/inode monitoring, TLS expiry monitoring, or off-VPS synthetic checkout checks.

## Create a backup

The backup contains a compressed MongoDB archive, a compressed media archive, a non-secret manifest, and SHA-256 checksums in one timestamped directory. Run it on a host with MongoDB Database Tools installed and read access to the persistent media volume.

```bash
cd backend
MONGODB_URI='mongodb://backup-user:SECRET@mongo1,mongo2/rich_culture?replicaSet=rs0' \
BACKUP_DATABASE_NAME=rich_culture \
MEDIA_STORAGE_ROOT=/srv/rich-culture/media \
BACKUP_ROOT=/srv/rich-culture-backups \
BACKUP_RETENTION_DAYS=14 \
APP_RELEASE=2026.08.20-1 \
npm run ops:backup
```

Use a root-readable environment file or service credential instead of putting secrets in shell history. The script uses restrictive file permissions, writes into a staging directory, publishes only a completed backup, excludes media staging files, and rejects unsafe root/home targets.

Expired-backup deletion is off by default. Enable it only for the dedicated backup root:

```dotenv
BACKUP_PRUNE_CONFIRM=DELETE_EXPIRED_RICH_CULTURE_BACKUPS
```

Copy every completed backup to encrypted storage outside the VPS and monitor age, size, checksum status, and off-site replication. Define the business RPO/RTO explicitly. A daily job usually implies up to a 24-hour RPO.

The MongoDB dump and media archive are produced sequentially. For a strict point-in-time pair, pause catalog/media writes during the job or use coordinated filesystem/database snapshots.

## Verify and restore-test

Checksum and media-extraction verification does not modify MongoDB:

```bash
npm run ops:verify-backup -- /srv/rich-culture-backups/rich-culture-20260820T120000Z
```

For the required isolated restore drill, use a non-production target database whose name starts with `rich_culture_restore_verify_`:

```bash
RESTORE_VERIFY_MONGODB_URI='mongodb://restore-user:SECRET@restore-mongo/rich_culture?replicaSet=rs0' \
RESTORE_VERIFY_DATABASE=rich_culture_restore_verify_20260820 \
npm run ops:verify-backup -- /srv/rich-culture-backups/rich-culture-20260820T120000Z
```

The verifier checks hashes, rejects unsafe media archive paths, extracts media into a temporary directory, restores with namespace remapping into the isolated database, checks collections and migration history, and drops the verification database afterward. Set `VERIFY_KEEP_DATABASE=true` only when an operator intentionally needs to inspect that isolated database.

Run an isolated restore at least monthly and after changing MongoDB, media layout, backup tools, or encryption. Record duration and result. Before any real disaster restore, also verify critical indexes, a MongoDB transaction, sample product media, a sample private evidence file, and an application smoke test; then run `npm run media:reconcile:prod`.

Never test a restore by overwriting the production database or production media directory.

## Scheduling and incident response

Schedule the backup through systemd or cron under a dedicated account, serialize runs with the scheduler, and alert on non-zero exit or an old latest-success timestamp. Do not rely only on log output. A minimal operating rhythm is:

- continuously scrape metrics and health;
- create and replicate backups daily;
- verify checksums after every copy;
- restore into an isolated environment monthly;
- review alert thresholds, capacity trend, backup duration, RPO, and RTO quarterly.

During an incident, preserve logs and the last known-good backup, stop unsafe writes if consistency is at risk, and choose rollback versus restore based on the migration and data impact. Application image rollback must never blindly reverse database migrations.
