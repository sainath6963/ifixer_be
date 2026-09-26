# Rich Culture API

Backend for the Rich Culture e-commerce platform. Implemented through Phase 24, including production acceptance/security gates and guarded load testing in addition to the core commerce, payment, fulfillment, returns, promotion, review, wishlist, notification, profile, analytics, shipment, mobile-channel, observability, and backup systems.

## Requirements

- Node.js 20.19 or newer
- npm 10 or newer
- Docker with Docker Compose

## Local setup

```bash
cp .env.example .env
npm install
npm run infra:up
npm run db:migrate
npm run db:seed
npm run admin:bootstrap
npm run start:dev
```

The default endpoints are:

- API metadata: `http://localhost:4000/api/v1`
- Liveness: `http://localhost:4000/api/v1/health/live`
- Readiness: `http://localhost:4000/api/v1/health/ready`
- Swagger UI: `http://localhost:4000/docs`
- OpenAPI JSON: `http://localhost:4000/docs-json`
- Protected metrics when enabled: `http://localhost:4000/api/v1/metrics`

## Verification

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Repository-level continuous integration is documented in [`../CI.md`](../CI.md). It runs this
quality suite and the MongoDB/Redis-backed E2E suite before validating both production containers.

The E2E suite requires the local MongoDB replica set and Redis services:

```bash
npm run infra:up
npm run test:e2e
```

## MongoDB requirement

Checkout, payment capture, and inventory transitions use multi-document transactions. MongoDB must run as a replica set. The local Docker service is configured as a single-node `rs0` replica set for development only. Production should use an authenticated replica set and off-server backups.

## Implemented through Phase 24

Included:

- Validated environment configuration
- MongoDB/Mongoose connection and replica-set readiness validation
- Redis and BullMQ base configuration
- Request IDs and structured/redacted logs
- Validation, CORS, Helmet, throttling, and consistent errors
- Liveness/readiness checks and Swagger
- Docker local infrastructure and automated tests
- Controlled MongoDB schemas, indexes, validators, migrations, and seed
- Argon2id admin passwords and one-time owner bootstrap
- HttpOnly access/rotating-refresh cookies, signed CSRF protection, live sessions, and replay revocation
- `OWNER`/`STAFF` role guards and security audit events
- Draft-first category/product/variant management with optimistic version checks
- Transactional initial inventory and idempotent audited stock adjustments
- Content-validated image upload, normalized WebP variants, public streaming, and safe media deletion
- Public active-category tree and descendant-category product filtering
- Paginated product listing, featured products, weighted text relevance, and price sorting/filtering
- Customer-safe product detail, ready-media URLs, and coarse stock availability without internal leakage
- Explicit public store configuration, cache controls, rate limits, and storefront query indexes
- Customer registration/login with Argon2id, isolated rotating sessions, scoped CSRF, and secure cookies
- One-time email verification and password recovery with encrypted outbox token envelopes
- Bounded customer saved-address books with one enforced default, optimistic concurrency, and audited mutations
- Guest and authenticated persistent carts with safe transactional guest-cart claiming
- Server-authoritative cart pricing, coarse quantity availability, optimistic versions, and TTL cleanup
- Authenticated checkout preview and idempotent transactional order creation
- Server-authoritative order snapshots and oversell-safe temporary inventory reservations
- Customer-owned order history/detail and idempotent unpaid-order cancellation
- BullMQ pending-payment expiry with transactional, single-release inventory transitions
- Order/audit/outbox records and strict Phase 7 validators/indexes
- One recoverable Razorpay provider order per internal order using unique receipts
- Server-side Checkout signature verification plus provider payment fetch/validation
- Exact raw-body webhook HMAC verification, event deduplication, and replay mismatch rejection
- Out-of-order-safe authorization/failure/capture transitions
- Atomic captured inventory commit from on-hand/reserved to sold
- Late-capture refund-required handling and BullMQ payment reconciliation
- Strict Phase 8 payment/webhook/capture indexes and validators
- Admin order search/detail dashboard with operational attention counts
- Optimistic, audited fulfillment transitions and validated shipping/tracking fields
- One-time physical return/cancellation inventory restock ledger
- OWNER-only, explicitly confirmed full and partial Razorpay refunds
- Atomic cumulative refund-capacity reservation and provider-level refund idempotency
- Signed refund webhook finalization, stale-event protection, and refund reconciliation
- Strict Phase 9 refund ledger, order search, and restock indexes/validators
- MongoDB transactional-outbox relay with atomic lease ownership and stale-lock recovery
- Idempotent email materialization for paid, shipped, delivered, and refunded customer events
- Operations email alerts for late captures and failed refunds
- Pooled SMTP transport with STARTTLS/implicit-TLS controls and safe local log mode
- Exponential delivery retries, dead-letter states, stable message IDs, and strict Phase 10 validators/indexes
- Admin notification search/counts plus audited OWNER-only outbox and delivery retries
- Customer-owned item return/exchange eligibility, idempotent requests, quantity allocation and cancellation
- Admin return queue with guarded approval, rejection, warehouse inspection and OWNER-only resolution
- Resaleable-quantity inventory restoration with a unique item-return movement ledger
- Succeeded-refund linkage for returns and manual courier/tracking completion for exchanges
- Strict Phase 13 return validators, indexes, optimistic versions and audit records
- Customer-owned return evidence uploads normalized to metadata-free WebP on private VPS storage
- Authenticated customer/admin evidence listing and streaming with no-store, same-origin delivery
- Atomic evidence limits, duplicate detection, pending/ready/deleted recovery and reconciliation
- Transactional return lifecycle outbox events with customer emails and new-request operations alerts
- Strict Phase 14 evidence validator, indexes, migration and security/integration coverage
- Atomic replacement-stock reservation when an exchange is approved
- Source-isolated checkout/exchange reservation records and unique inventory movement ledgers
- Configurable approval hold deadline with BullMQ expiry, stock release and customer email
- Receipt-time reservation validation and exactly-once replacement sale commit at dispatch completion
- Customer/admin reservation visibility plus strict Phase 15 validators and indexes
- Draft-first coupon campaigns with OWNER-only mutation and STAFF read access
- Fixed/percentage discounts, minimum spends, percentage caps, date windows and global usage limits
- One-use-per-customer redemption records reserved with unpaid orders, redeemed on capture and released on cancellation/expiry
- Immutable order coupon snapshots, trusted Razorpay discounted totals and strict Phase 16 validators/indexes
- Delivered-order-only customer product reviews with one review per customer/product
- Customer revision, resubmission and withdrawal using optimistic versions and ownership guards
- OWNER/STAFF moderation queue with search, rating/status filters and customer-visible rejection feedback
- Public published-review responses with masked customer names and no order/customer identifier leakage
- Transactional integer rating summaries isolated from catalog product versions
- Strict Phase 17 review/summary validators, indexes and customer/admin audit events
- Customer-owned, idempotent product wishlists with current storefront-card hydration
- Verified-email, variant-level back-in-stock subscriptions restricted to unavailable inventory
- Central inventory scanner covering restocks and reservation releases without stock-writer coupling
- Atomic one-shot alert transitions with deterministic transactional outbox events
- Duplicate-safe `STOCK_ALERT_AVAILABLE` email materialization and production-origin product links
- OWNER/STAFF stock-demand aggregation without customer identity exposure
- Strict Phase 18 wishlist/alert validators, indexes and customer audit events
- Authenticated customer name/contact/preferences management with optimistic profile versions
- One-time verified email changes with all-session revocation and hashed mobile OTP challenges
- Safe account deactivation with active-order/return blocking and read-only admin customer profiles
- India business-day analytics for captured sales, settled refunds, net revenue, paid orders and customer growth
- Equal-period comparisons, adaptive trend grouping, top-product snapshots and current low-stock signals
- Guarded CSV analytics export plus strict 366-day range limits and Phase 20 reporting indexes
- Provider-neutral manual shipment creation with unique courier/AWB ownership
- Guarded ready, transit, out-for-delivery, exception and delivered tracking transitions
- Transactional order/fulfillment synchronization, chronological customer-safe events and audit/outbox records
- Customer/admin shipment timelines, delivery-exception operations counts and strict migration 021 validators/indexes
- Provider-neutral SMS/WhatsApp delivery through a private HTTPS adapter, consent enforcement, OTP delivery selection, lifecycle messaging, and strict migration 022 constraints
- Protected Prometheus-compatible HTTP, queue, payment, notification, fulfillment, process, and disk metrics with bounded labels
- Media free-space readiness floor plus guarded MongoDB/media backup, checksum, retention, and isolated restore-verification scripts
- Redis-backed distributed rate limiting with production-only proxy, CORS, Swagger, and release configuration guards
- Sanitized public readiness, authenticated detailed admin health, API hardening, and Razorpay-compatible Nginx CSP/HSTS headers
- Guarded read-only production smoke and bounded health/storefront load-test profiles with measurable thresholds

Still intentionally deferred to later phases: vendor API courier booking/labels/webhooks, concrete monitoring/on-call provider configuration, external penetration testing, and authorized live production capacity testing.

## Database model and migrations

Phase 2 adds controlled Mongoose schemas, named indexes, critical MongoDB collection validators, migration locking, and an idempotent baseline settings seed.

```bash
npm run db:migrate
npm run db:seed
```

Operational backup and restore guidance is documented in [`docs/database-operations.md`](docs/database-operations.md).

Admin bootstrap, browser flow, cookie policy, token rotation, and endpoint behavior are documented in [`docs/admin-authentication.md`](docs/admin-authentication.md).

Catalog invariants, admin endpoints, local media storage, VPS mounts, reconciliation, and backup requirements are documented in [`docs/catalog-and-local-media.md`](docs/catalog-and-local-media.md).

Public endpoints, filters, visibility rules, safe response fields, caching, and search/index behavior are documented in [`docs/storefront-catalog.md`](docs/storefront-catalog.md).

Customer session cookies, CSRF flow, guest-cart merge rules, cart endpoints, pricing, expiry, and new production secrets are documented in [`docs/customer-auth-and-cart.md`](docs/customer-auth-and-cart.md).

Saved-address endpoints, invariants, optimistic concurrency, checkout behavior, auditing, and migration 011 are documented in [`docs/customer-saved-addresses.md`](docs/customer-saved-addresses.md).

Email verification, enumeration-safe password recovery, one-time token security, delivery behavior, and migration 012 are documented in [`docs/customer-account-recovery.md`](docs/customer-account-recovery.md).

Checkout endpoints, idempotency, transactional stock reservations, customer order access, cancellation, automatic expiry, and the Razorpay boundary are documented in [`docs/checkout-and-orders.md`](docs/checkout-and-orders.md).

Razorpay credentials, customer payment APIs, frontend handoff, signature/webhook security, payment transitions, reconciliation, and Test/Live Mode operations are documented in [`docs/razorpay-payments.md`](docs/razorpay-payments.md).

Admin order APIs, fulfillment transitions, shipping/tracking, refund safety, operations counts, and Phase 9 deployment are documented in [`docs/admin-order-operations.md`](docs/admin-order-operations.md).

Transactional email events, SMTP configuration, outbox guarantees, admin delivery APIs, and Phase 10 deployment are documented in [`docs/notification-delivery.md`](docs/notification-delivery.md).

Customer return policy, item allocations, private evidence, lifecycle email, exchange reservations, admin inspection/resolution, inventory safety, and migrations 013–015 are documented in [`docs/return-exchange-requests.md`](docs/return-exchange-requests.md).

Coupon administration, checkout eligibility, transactional usage allocation, payment/cancellation transitions, and migration 016 are documented in [`docs/coupon-promotions.md`](docs/coupon-promotions.md).

Verified-purchase eligibility, customer/admin review APIs, moderation transitions, public privacy rules, atomic rating summaries, and migration 017 are documented in [`docs/product-reviews.md`](docs/product-reviews.md).

Wishlist ownership, verified-email stock subscriptions, inventory scanning, admin demand visibility, duplicate-safe notification delivery, and migration 018 are documented in [`docs/wishlist-stock-alerts.md`](docs/wishlist-stock-alerts.md).

Customer identity changes, preferences, OTP boundary, safe deactivation, admin customer visibility, and migration 019 are documented in [`docs/customer-profile-management.md`](docs/customer-profile-management.md).

Admin metric definitions, India date boundaries, comparison semantics, CSV safety, and migration 020 are documented in [`docs/admin-business-analytics.md`](docs/admin-business-analytics.md).

Shipment transitions, manual AWB operations, customer visibility, integrity rules, adapter boundary, and migration 021 are documented in [`docs/shipment-tracking.md`](docs/shipment-tracking.md).

Protected metrics, alerting policy, backup retention, checksum verification, and isolated restore drills are documented in [`docs/observability-and-backups.md`](docs/observability-and-backups.md).

Production startup guards, health-information boundaries, browser headers, smoke checks, controlled load tests, and manual release acceptance are documented in [`docs/production-acceptance-and-security.md`](docs/production-acceptance-and-security.md).
