# Customer returns and exchanges

Phase 13 adds item-level customer return/exchange requests and a guarded warehouse workflow. Phase 14 adds private customer evidence images and durable lifecycle email notifications. Phase 15 atomically reserves replacement stock at exchange approval and commits it at dispatch. It does not book reverse pickup or replacement couriers automatically; those integrations remain behind the stored manual tracking contract.

## Policy

- Only an authenticated owner of a delivered order can create a request.
- The order must be `PAID` or `PARTIALLY_REFUNDED`.
- The request must be created within `CUSTOMER_RETURN_WINDOW_DAYS` after `shipping.deliveredAt`; the default is 7 days and the supported production range is 1–30 days.
- Quantities are allocated per ordered variant across `REQUESTED`, `APPROVED`, `RECEIVED`, and `COMPLETED` requests. Rejected or customer-cancelled requests release their allocation.
- An exchange target must be a different active variant of the same active product and currently have available stock. Request creation is only an availability preview; approval revalidates and atomically reserves the full replacement quantity.
- Estimated values are derived only from the immutable order-item snapshot. They are informational. The owner selects a real succeeded Razorpay refund when completing a return.

Customer request creation requires a 16–160 character `Idempotency-Key`. The server stores a SHA-256 request fingerprint and returns the same request for an identical retry. Reusing the key for another payload returns `409 IDEMPOTENCY_KEY_REUSED`.

## Customer API

All routes require customer cookies; mutations also require customer CSRF.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/customer/orders/:orderNumber/returns` | Eligibility, deadline, remaining item quantities, exchange options, and request history |
| `POST` | `/customer/orders/:orderNumber/returns` | Create an idempotent return or exchange request |
| `POST` | `/customer/orders/:orderNumber/returns/:returnNumber/cancel` | Cancel only a `REQUESTED` request using `expectedVersion` |
| `GET` | `/customer/orders/:orderNumber/returns/:returnNumber/evidence` | List private evidence owned by this customer/request |
| `POST` | `/customer/orders/:orderNumber/returns/:returnNumber/evidence` | Normalize and attach one private evidence image while `REQUESTED` |
| `GET` | `/customer/orders/:orderNumber/returns/:returnNumber/evidence/:evidenceId/content` | Stream one authenticated evidence image |
| `DELETE` | `/customer/orders/:orderNumber/returns/:returnNumber/evidence/:evidenceId` | Remove evidence while `REQUESTED` |

The customer response excludes internal notes, admin IDs, exact inventory counts, and provider details. Customer-facing decision/inspection/resolution messages and replacement tracking are visible.

## Admin API and state machine

`OWNER` and `STAFF` can list, inspect, decide, and receive requests. Final completion is `OWNER`-only because a return must reference a settled refund and an exchange creates an externally visible shipment record.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/admin/returns` | OWNER, STAFF | Paginated status/type/search queue |
| `GET` | `/admin/returns/:returnNumber` | OWNER, STAFF | Full request, private note, timeline, and version |
| `PATCH` | `/admin/returns/:returnNumber/decision` | OWNER, STAFF | Approve or reject `REQUESTED` |
| `PATCH` | `/admin/returns/:returnNumber/receive` | OWNER, STAFF | Inspect `APPROVED` items and state resaleable quantities |
| `PATCH` | `/admin/returns/:returnNumber/complete` | OWNER | Close `RECEIVED` with refund or replacement tracking |
| `GET` | `/admin/returns/:returnNumber/evidence` | OWNER, STAFF | List private customer evidence |
| `GET` | `/admin/returns/:returnNumber/evidence/:evidenceId/content` | OWNER, STAFF | Stream one authenticated evidence image |

```text
REQUESTED -> APPROVED -> RECEIVED -> COMPLETED
    |          |
    |          +-> EXPIRED (exchange approval hold elapsed before receipt)
    +-> REJECTED
    +-> CANCELLED (customer only, before decision)
```

Every mutation requires the latest request `expectedVersion`. Stale screens receive `409 RETURN_VERSION_CONFLICT`.

## Private evidence storage

Evidence accepts only content-decodable, single-frame JPEG, PNG, WebP, or AVIF input. Sharp applies orientation, limits pixels, scales inside 1600 × 1600 without enlargement, strips source metadata through re-encoding, and persists WebP. Client MIME headers and extensions are never trusted.

`RETURN_EVIDENCE_MAX_FILES` defaults to 5 and supports 1–10. `RETURN_EVIDENCE_MAX_UPLOAD_BYTES` defaults to 5 MiB and supports 256 KiB–10 MiB. A checksum unique within the active request rejects duplicate evidence. Upload, removal, and the request's `evidenceCount` are transactionally guarded; the image can change only while status is `REQUESTED`.

Files live below `MEDIA_STORAGE_ROOT/private/return-evidence`, never below a public static directory. Database responses return authenticated content endpoints rather than storage keys. Customer queries include customer, order, and return ownership; admin queries require `OWNER` or `STAFF`. Content responses are `private, no-store` and `Cross-Origin-Resource-Policy: same-origin`.

MongoDB and the filesystem cannot commit atomically, so evidence moves through `PENDING -> READY` and customer removal marks it `DELETED`. `npm run media:reconcile:prod` removes stale staging/pending evidence, corrects its request counter, removes deleted files, and reports `readyReturnEvidenceMissingFiles`. Alert whenever that count is non-zero.

## Lifecycle email

Every `REQUESTED`, `APPROVED`, `REJECTED`, `CANCELLED`, `RECEIVED`, and `COMPLETED` transition writes its return state and one deterministic outbox event in the same MongoDB transaction. Customers receive the corresponding email when their order snapshot has an email address. A new `REQUESTED` event also notifies every configured operations address. Evidence contents and private URLs are never placed in email or outbox payloads. Materialization and SMTP retry behavior follow [notification-delivery.md](notification-delivery.md).

For a `RETURN`, completion must use `resolutionType: REFUND` and reference a `SUCCEEDED` refund belonging to the same order. A refund can resolve only one request. For an `EXCHANGE`, completion must use `resolutionType: EXCHANGE` and include courier and tracking number; an optional tracking URL must be HTTPS.

## Replacement inventory reservation

When an exchange moves from `REQUESTED` to `APPROVED`, the transaction rechecks that every target product and variant is active and that `onHand - reserved` covers the aggregated requested quantity. It then increments `inventory_levels.reserved`, writes source-isolated `inventory_reservations` using `returnRequestId`, and records one `EXCHANGE_REPLACEMENT_RESERVE` movement per target variant. A failed target rolls back the entire decision and returns `409 EXCHANGE_TARGET_OUT_OF_STOCK` or `EXCHANGE_TARGET_UNAVAILABLE`.

`EXCHANGE_RESERVATION_TTL_DAYS` controls the approval hold from 1–60 days; the default is 14. A BullMQ worker checks once per minute. If an approved exchange has not been received by its deadline, one transaction releases `reserved`, finalizes reservations as `EXPIRED`, writes `EXCHANGE_REPLACEMENT_EXPIRE`, moves the request to `EXPIRED`, releases its original-order return allocation, audits the transition, and emits the customer email.

Warehouse receipt requires an active, unexpired, quantity-complete reservation for Phase 15 exchanges. Once receipt succeeds, automatic expiry no longer applies, so inspected parcels do not lose their replacement while the owner records dispatch. Completing the exchange decrements replacement `onHand` and `reserved`, increments `sold`, finalizes reservations as `COMMITTED`, and writes `EXCHANGE_REPLACEMENT_COMMIT`. Unique transition indexes and optimistic request versions prevent double reserve, release, or dispatch.

Pre-Phase-15 approved/received/completed exchanges have no reservation marker and remain operable as explicit legacy records. The admin UI labels them as untracked; review those manually before enabling the new release.

## Inventory and concurrency safety

Request creation, cancellation, and admin decisions also write the parent order's `returnAllocationRevision`. Concurrent requests for the same order therefore conflict and are retried under MongoDB snapshot transactions before quantities are re-evaluated.

Receiving a parcel does not automatically restock every requested unit. The operator records `restockQuantity` from 0 through the requested quantity for each variant after inspection. Only that resaleable amount increments `onHand` and decrements `sold`. Each variant writes one unique `RETURN_REQUEST_RECEIPT` movement, preventing a retry from restocking twice.

The legacy whole-order `DELIVERED -> RETURNED` operation is blocked with `ORDER_HAS_ITEM_RETURN_REQUESTS` once any non-rejected/non-cancelled item request exists. This prevents the legacy restock ledger and the item receipt ledger from both restoring the same sold units.

## Deployment

Run migrations through 015 before starting the new application instances:

```bash
npm run db:migrate:prod
npm run start:prod
```

`013-return-exchange-requests` creates the request collection, strict validator and named queue/idempotency/refund indexes; backfills `orders.returnAllocationRevision`; and adds the unique return-receipt inventory movement index.

`014-return-evidence-notifications` creates the strict `return_evidence` collection, active checksum/storage/maintenance indexes, and backfills `return_requests.evidenceCount`.

`015-exchange-stock-reservations` adds source-safe exchange reservation fields, expiry/return lookup indexes, unique reserve/commit/expire movement indexes, and strict request/reservation state invariants. It does not guess or mutate historical exchange inventory.

Before enabling customer requests, set the policy/evidence/reservation limits, verify the private media mount and warehouse disposition process, and run Test Mode scenarios for partial quantities, rejected/cancelled/expired allocations, simultaneous exchange approvals, damaged non-restockable pieces, evidence access control, refunds, exchange tracking, and each lifecycle email.

## Deliberate boundaries

This phase does not generate return labels, book courier pickup, or send push notifications. Phase 22 adds opted-in SMS/WhatsApp return-status updates alongside email and the stored customer/admin timelines.
