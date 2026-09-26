# Admin Catalog, Inventory, and Local Media

## Phase boundary

Phase 4 provides authenticated admin management for categories, products, variants, product images, and physical on-hand stock. It also provides public delivery of normalized image variants. Storefront, cart, checkout/orders, Razorpay payments/refunds, and admin fulfillment now live in their own modules.

## Catalog rules

- Categories and products are created as `DRAFT`.
- There are no hard-delete product or variant APIs. Products are archived and variants are deactivated so future order snapshots and inventory history remain meaningful.
- Every catalog update carries `expectedVersion`. A `409 *_VERSION_CONFLICT` means another admin changed the record; reload before retrying.
- Prices are integer paise. Floating-point rupee values are rejected.
- Product slugs and variant SKUs are globally unique.
- Product creation, variant creation, initial inventory, movements, and audit records use MongoDB transactions.
- A product can become `ACTIVE` only when it has an active category, an active variant, and a ready primary image.
- Only active products can be featured.
- Stock adjustments require a stable idempotency key. Retrying the same payload returns the current stock without creating another movement. Reusing the key with different data returns `409`.
- An adjustment cannot reduce `onHand` below zero or below already reserved stock.

## Local image pipeline

Uploads use in-memory Multer buffering with a strict request limit, followed by content decoding in Sharp. Client filename extensions and MIME headers are not trusted.

Accepted inputs are single-frame JPEG, PNG, WebP, and AVIF. The pipeline enforces configured byte and pixel limits, applies orientation, strips source metadata through re-encoding, and writes WebP outputs:

| Variant | Maximum box | Resize behavior |
| --- | ---: | --- |
| `original` | 2400 × 2400 | Fit inside, never enlarge |
| `thumbnail` | 320 × 320 | Fit inside, never enlarge |
| `card` | 800 × 1000 | Fit inside, never enlarge |
| `large` | 1600 × 2000 | Fit inside, never enlarge |

The API exposes database-backed URLs such as `/api/v1/media/{assetId}/card`; internal filesystem keys are never returned. A media asset cannot be deleted while referenced by a product or category.

MongoDB and a local filesystem cannot participate in one atomic transaction. Uploads therefore move through `PENDING` to `READY`; only `READY` assets can be attached or served. The maintenance command removes stale staging/pending data, removes leftover files for `DELETED` assets, and reports missing files for `READY` assets:

```bash
npm run media:reconcile
# Built production release
npm run media:reconcile:prod
```

Run reconciliation daily from systemd timer or cron and alert whenever `readyAssetsMissingFiles` or `readyReturnEvidenceMissingFiles` is non-zero. The same command also reconciles the private return-evidence staging/pending/deleted lifecycle documented in [`return-exchange-requests.md`](return-exchange-requests.md).

## VPS storage setup

Use a persistent path outside the application release directory:

```bash
sudo install -d -o 1000 -g 1000 -m 0750 /var/lib/rich-culture/media
```

Production configuration:

```dotenv
MEDIA_STORAGE_ROOT=/var/lib/rich-culture/media
MEDIA_MAX_UPLOAD_BYTES=10485760
MEDIA_MAX_INPUT_PIXELS=40000000
MEDIA_WEBP_QUALITY=82
MEDIA_STAGING_MAX_AGE_SECONDS=3600
RETURN_EVIDENCE_MAX_FILES=5
RETURN_EVIDENCE_MAX_UPLOAD_BYTES=5242880
```

For Docker, bind-mount the host directory at the exact configured container path and keep it writable by the runtime `node` user. Do not place uploads inside an image layer or ephemeral container filesystem.

This local-storage design assumes one API instance or a shared filesystem. Before running multiple application VPS nodes, migrate media behind an object-storage abstraction; otherwise different nodes can return inconsistent files.

## Backup and recovery

- Back up `MEDIA_STORAGE_ROOT` independently from MongoDB.
- Pause image mutations or use filesystem snapshots when creating a database/media recovery point.
- Encrypt off-server copies and validate restores in staging.
- After restore, run `media:reconcile:prod` and require both `readyAssetsMissingFiles: 0` and `readyReturnEvidenceMissingFiles: 0`.
- A database backup without the matching media backup is not a complete store backup.

## Admin endpoints

All `/admin/*` mutations require access cookies, an allowed admin role, and the signed CSRF header.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/admin/categories` | Create draft category |
| GET | `/admin/categories` | Paginated category list |
| GET | `/admin/categories/:id` | Category detail |
| PATCH | `/admin/categories/:id` | Edit/status transition with version check |
| POST | `/admin/media/images` | Validate and process one image |
| GET | `/admin/media` | Paginated media list |
| DELETE | `/admin/media/:id` | Delete unreferenced media |
| POST | `/admin/products` | Atomically create draft product, variants, and stock |
| GET | `/admin/products` | Paginated/filterable/searchable product list |
| GET | `/admin/products/:id` | Product detail with inventory |
| PATCH | `/admin/products/:id` | Edit/publish/archive with version check |
| POST | `/admin/products/:id/variants` | Add variant and inventory |
| PATCH | `/admin/products/:id/variants/:variantId` | Edit/deactivate variant |
| PUT | `/admin/products/:id/images` | Replace ordered image set |
| POST | `/admin/products/:id/variants/:variantId/inventory-adjustments` | Idempotent stock adjustment |
| GET | `/media/:assetId/:variant` | Public normalized WebP delivery |
