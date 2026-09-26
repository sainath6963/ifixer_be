# MongoDB Operations Runbook

## Deployment requirement

Rich Culture uses multi-document transactions for checkout, inventory reservation/release, and captured-payment inventory commits. Every environment must use MongoDB replica-set mode. A standalone production MongoDB is not supported by this application.

Verify before deployment:

```javascript
const hello = db.hello();
({ replicaSet: hello.setName, writablePrimary: hello.isWritablePrimary });
```

## Controlled migrations

Do not use application startup to mutate production indexes or validators. Run the migration as a separate release step:

```bash
npm run build
npm run db:migrate:prod
```

Development:

```bash
npm run db:migrate
```

Migrations use a database lock, are ordered, and record completed IDs in `database_migrations`. A partially completed migration is written to the history only after its work succeeds.

## Development seed

The seed is idempotent and inserts only baseline store settings. It does not create an admin account or publish sample products.

```bash
npm run db:seed
```

Production seeding is intentionally blocked.

## Backup policy for the VPS

- Run a compressed `mongodump` at least daily.
- Store the MongoDB connection in a root-readable config/secret file, not in a committed script.
- Encrypt backup archives before sending them off the VPS.
- Keep at least one backup in a different provider or physical location.
- Back up the configured media directory separately from MongoDB.
- Run `npm run media:reconcile:prod` after every database/media restore and investigate missing public assets or private return evidence.
- Monitor backup age and archive size; a command exit code alone is insufficient.
- Test restoration into an isolated staging database at least monthly.

The maintained backup and isolated verification commands are documented in [`observability-and-backups.md`](observability-and-backups.md). They produce this backup shape:

```text
/var/backups/rich-culture/rich-culture-YYYYMMDDTHHMMSSZ/
├── mongodb.archive.gz
├── media.tar.gz
├── manifest.env
└── SHA256SUMS
```

Do not keep the only backup on the same VPS disk.

## Restore procedure

1. Create an isolated MongoDB replica set for restore validation.
2. Verify the backup checksum.
3. Restore the archive with `mongorestore --archive --gzip` using secret-managed credentials.
4. Run the application readiness check.
5. Verify migration history, collection counts, critical indexes, and a transaction smoke test.
6. Verify a sample product/order manually before approving the restore.
7. Never restore over production until the isolated validation succeeds.

## Index changes

- Add indexes through a numbered migration.
- Build high-impact production indexes during a low-traffic window.
- Review duplicate data before converting an existing index to unique.
- Removing an index requires a separate reviewed migration; schema `createIndexes()` never drops indexes automatically.
