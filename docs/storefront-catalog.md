# Storefront catalog API

Phase 5 adds a read-only customer catalog under `/api/v1/catalog`. It is intentionally separate from the authenticated admin catalog and never returns local storage keys, exact stock counts, reservations, sales counters, audit fields, or optimistic-lock versions.

## Endpoints

| Method | Path | Purpose | Cache-Control |
| --- | --- | --- | --- |
| `GET` | `/catalog/config` | Settings explicitly marked `isPublic: true` | `public, max-age=60, stale-while-revalidate=300` |
| `GET` | `/catalog/categories` | Nested active-category tree | `public, max-age=60, stale-while-revalidate=300` |
| `GET` | `/catalog/products` | Published product list, search, filters, and sorting | `public, max-age=15, stale-while-revalidate=30` |
| `GET` | `/catalog/products/featured` | Featured subset of the product list | `public, max-age=15, stale-while-revalidate=30` |
| `GET` | `/catalog/products/:slug` | Published product detail | `public, max-age=15, stale-while-revalidate=30` |

These endpoints do not require an admin cookie or CSRF token. They have route-specific rate limits in addition to the global throttler.

## Product query contract

`GET /catalog/products` and `GET /catalog/products/featured` accept:

| Parameter | Rules | Meaning |
| --- | --- | --- |
| `page` | integer, `1..1000`, default `1` | Page number |
| `limit` | integer, `1..48`, default `24` | Page size |
| `search` | string, maximum 80 characters | MongoDB text search over weighted name, tags, and description |
| `category` | normalized slug, maximum 160 characters | Includes the selected active category and all active descendants |
| `minPriceInPaise` | non-negative safe integer | Minimum active-variant price |
| `maxPriceInPaise` | non-negative safe integer | Maximum active-variant price |
| `sort` | `relevance`, `newest`, `price-asc`, or `price-desc` | Result ordering |

When `search` is present, the default sort is `relevance`; otherwise it is `newest`. Explicit `relevance` without a search falls back to newest. A minimum greater than the maximum returns `400 PRICE_RANGE_INVALID`. Unknown or inactive category slugs return `404 CATEGORY_NOT_FOUND` instead of silently broadening the query.

Prices are always integer paise and currency is currently `INR`. Price filters and price ranges use only active variants matching the requested range.

Example:

```bash
curl 'http://localhost:4000/api/v1/catalog/products?category=mens-shirts&minPriceInPaise=100000&maxPriceInPaise=300000&sort=price-asc&page=1&limit=24'
```

## Visibility and safe output

A public product must have:

- `status: ACTIVE`
- `publishedAt` less than or equal to the request time
- at least one active variant, including one matching the optional price filter

Only active categories and media assets with `status: READY` are returned. A missing or non-ready image is omitted rather than exposing an unusable filesystem reference.

Product responses expose customer-safe fields only: public IDs/slugs, content, category references, integer prices, ready media URLs, active variants, tags, featured state, and coarse availability. Media URLs use `/api/v1/media/:mediaAssetId/:variant`; they never expose VPS paths or `storageKey` values.

Availability is deliberately only `IN_STOCK` or `OUT_OF_STOCK`, calculated as `onHand - reserved > 0`. This value is advisory for browsing. Phase 7 checkout re-reads and reserves inventory transactionally; the storefront response must never be treated as a stock guarantee.

## Query and index behavior

Migration `005-storefront-catalog-indexes` adds:

- `ix_products_storefront_newest` for active publication/newest access
- `ix_products_storefront_variant_price` for active-variant price filtering

The existing `tx_products_search` weighted text index provides self-managed MongoDB search and `$meta: "textScore"` relevance sorting. Category, media, and inventory enrichment is batched per result page rather than queried once per product. E2E coverage also runs an execution plan with the newest index hint so index usability fails visibly during CI.

MongoDB text indexes are intentionally the Phase 5 baseline because the current VPS already runs MongoDB. Search capabilities such as typo tolerance, autocomplete, facets, and language-specific ranking can be added later behind the same API contract if the store adopts a dedicated search engine or MongoDB Search.

## Deployment order

On each VPS deployment:

```bash
npm run db:migrate:prod
npm run start:prod
```

Run the migration before shifting traffic to the Phase 5 application. It is lock-protected and idempotent. Existing VPS-local media mounts and backups remain mandatory as described in [`catalog-and-local-media.md`](catalog-and-local-media.md).

## Deferred scope

This read-only storefront module does not itself mutate customer accounts, carts, orders, inventory, payments, or refunds. Those write paths live in the isolated customer, checkout, Razorpay payment, and admin order modules with their own authorization, idempotency, transaction, and payment-security controls.
