# Wishlists and back-in-stock alerts

Phase 18 adds customer-owned product wishlists, verified-email stock subscriptions, an admin demand view, and automatic notification dispatch when an option becomes available.

## Customer API

Every route requires the customer access cookie and customer CSRF protection. Reads are `no-store`; writes are rate limited and audited.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/customer/wishlist?page=1&limit=12` | List saved products that are still active and published |
| `GET` | `/customer/wishlist/products/:productId` | Read membership for one product |
| `POST` | `/customer/wishlist/:productId` | Idempotently save one active, published product |
| `DELETE` | `/customer/wishlist/:productId` | Idempotently remove one product |
| `GET` | `/customer/stock-alerts` | List the customer's active subscriptions |
| `GET` | `/customer/stock-alerts/product/:productId` | Read email eligibility and active option IDs |
| `POST` | `/customer/stock-alerts/:productId/variants/:variantId` | Subscribe to an unavailable active option |
| `DELETE` | `/customer/stock-alerts/:productId/variants/:variantId` | Cancel an active subscription |

Wishlist entries reference products rather than copying catalog content. List responses reload the current public card, so archived or unpublished products are hidden without deleting the customer's stored entry.

A stock subscription requires the customer's current email to be verified. The service reloads the customer, product, active variant, and inventory level from MongoDB; the browser cannot declare an item sold out or choose an arbitrary email. A request is rejected when `onHand - reserved > 0`.

Only one active subscription is allowed per customer/variant. Repeated save, subscribe, remove, and cancel requests are safe and do not create duplicate active records or audit events.

## Admin demand API

`GET /admin/stock-demand?page=1&limit=20&search=linen` requires an authenticated `OWNER` or `STAFF` admin. It groups active alerts by product option and returns subscriber count, current available stock, SKU, and latest request time. Results rank the highest active demand first. Customer identity and email are never exposed.

## Dispatch and notification guarantees

The existing notification sweep first scans up to 100 active alerts whose current inventory satisfies `onHand > reserved`. This central scan covers every stock source—including admin adjustments, order/return releases, restocks, and expired exchange holds—without coupling alert logic to each inventory writer.

For each match, one MongoDB transaction atomically:

1. changes the alert from `ACTIVE` to `NOTIFIED` and makes it inactive;
2. sets `notifiedAt`; and
3. inserts the deterministic outbox event `stock-alert:<alertId>`.

The transactional outbox then materializes `STOCK_ALERT_AVAILABLE` through the existing retryable email pipeline. The template reloads an active customer with a still-verified email and builds the product link from `PUBLIC_STOREFRONT_URL`. The email explicitly says that an alert does not reserve inventory. Re-running either scanner or outbox relay cannot create another notification for the same alert.

An alert is one-shot. If stock sells out again after notification, the customer may create a new active subscription. Cancelling an alert prevents later dispatch.

## Storage and migration

Migration `018-wishlist-stock-alerts` creates `wishlist_items` and `stock_alerts`, named lookup/worker/demand indexes, the partial unique active-subscription constraint, and strict MongoDB validators for state/timestamp consistency.

Deploy in this order:

```bash
npm run build
npm run db:migrate:prod
npm run start:prod
```

MongoDB must remain a replica set because wishlist audits and stock-alert/outbox transitions use transactions. No new environment variables or external storage services are required; email delivery uses the existing SMTP configuration.

After deployment, verify with a test customer whose email is verified: save a product, subscribe to an option with zero available stock, confirm it appears in `/admin/stock-demand`, add inventory, wait for the notification sweep, and confirm exactly one `STOCK_ALERT_AVAILABLE` delivery. Also confirm the admin demand row disappears and the email's product URL uses the production HTTPS origin.
