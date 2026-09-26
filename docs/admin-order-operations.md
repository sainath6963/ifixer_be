# Admin order operations and refunds

Phase 9 gives authenticated operators a server-authoritative order dashboard, guarded fulfillment transitions, shipping/tracking fields, full and partial Razorpay refunds, and operational attention counts.

## Authorization

All routes require the admin access cookie and admin CSRF token and return `Cache-Control: no-store`.

- `OWNER` and `STAFF` can list orders, inspect full order/payment/refund history, update the private admin note, and manage fulfillment.
- Only `OWNER` can issue a refund. A refund is an irreversible financial action and cannot be cancelled after Razorpay accepts it.

## Admin API

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/admin/orders` | OWNER, STAFF | Paginated search and status/date filtering |
| `GET` | `/admin/orders/operations-summary` | OWNER, STAFF | Fulfillment, refund, and late-capture attention counts |
| `GET` | `/admin/orders/:orderNumber` | OWNER, STAFF | Full order, address, item, payment, refund, history, shipping, and version view |
| `PATCH` | `/admin/orders/:orderNumber/admin-note` | OWNER, STAFF | Set or clear the private operator note |
| `PATCH` | `/admin/orders/:orderNumber/fulfillment` | OWNER, STAFF | Apply one legal fulfillment transition |
| `POST` | `/admin/orders/:orderNumber/refunds` | OWNER | Issue an irreversible full or partial Razorpay refund |

The order list supports `page`, `limit`, `search`, `lifecycleStatus`, `financialStatus`, `fulfillmentStatus`, `createdFrom`, and `createdTo`. Search input is escaped before it is used as a case-insensitive regular expression.

Every mutation requires the latest `expectedVersion`. A stale admin screen receives `409 ORDER_VERSION_CONFLICT`; reload the detail before deciding whether to retry.

## Fulfillment state machine

Allowed transitions are deliberately one-way:

```text
UNFULFILLED -> PROCESSING -> SHIPPED -> DELIVERED -> RETURNED
      |             |
      +-------------+-> CANCELLED (only after a full refund)
```

- Processing, shipping, and delivery require a paid or partially refunded order.
- Shipping requires a courier name and tracking number. An optional tracking URL must use HTTPS.
- Fulfillment cannot advance while any refund amount is still pending at Razorpay.
- Delivery marks the order lifecycle `COMPLETED`.
- A fully refunded order can be cancelled only before shipping.
- Cancelling a captured-but-unshipped order or recording a physical return restores `onHand`, decrements `sold`, writes one unique `ORDER_FULFILLMENT_RESTOCK` movement per variant, and cannot restock twice.
- The legacy whole-order `RETURNED` transition is rejected once an item-level request is active or completed. Use the Phase 13 workflow in [return-exchange-requests.md](return-exchange-requests.md) so stock is restored only after item inspection.
- A refund alone never restocks inventory. Money movement and physical stock movement remain separate decisions.

Customer order responses include the customer-safe courier, tracking number/URL, shipped time, and delivered time after they exist. Private notes and provider identifiers remain admin-only.

## Refund request

The request requires an `Idempotency-Key` header with 16–160 safe ASCII characters and a body such as:

```json
{
  "expectedOrderVersion": 4,
  "amountInPaise": 50000,
  "reason": "Customer accepted a partial refund for a damaged item",
  "confirmRefund": true
}
```

The backend never accepts a provider payment ID from the admin UI. It resolves the captured payment from MongoDB and checks that:

- the internal payment is `CAPTURED`;
- the order is `PAID` or `PARTIALLY_REFUNDED`;
- the amount is a positive integer in paise;
- successful plus in-flight refunds cannot exceed the captured amount;
- a reused idempotency key has the identical order, amount, and reason.

Before calling Razorpay, the amount is reserved in the payment ledger inside a MongoDB transaction. Concurrent admins therefore cannot create refunds whose combined value exceeds the captured amount.

Each refund gets a stable `RF-...` refund number. It is sent as both Razorpay `receipt` and `X-Refund-Idempotency`, so a network timeout can be retried safely without issuing the refund twice. This follows Razorpay's [idempotent normal refund API](https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/?preferred-country=IN). Normal refunds use `POST /v1/payments/:id/refund`, integer smallest-unit amounts, and `speed: normal` as documented in the [Create Normal Refund API](https://razorpay.com/docs/api/refunds/create-normal/?preferred-country=IN).

## Refund states

| Internal state | Meaning |
| --- | --- |
| `PENDING` | Locally reserved; provider result is not yet known |
| `PROCESSING` | Razorpay accepted the refund and reports `pending` |
| `SUCCEEDED` | Razorpay reports `processed`; financial totals are committed |
| `FAILED` | Razorpay definitively rejected or failed it; reserved refund capacity is released |

A successful partial refund changes the order financial state to `PARTIALLY_REFUNDED`. When the cumulative processed amount equals the captured payment, it becomes `REFUNDED`. Provider fees are never guessed or subtracted from the customer refund amount.

Razorpay notes that a normal refund can remain pending and recommends `refund.processed` as the definitive update. The raw-body webhook handler supports `refund.created`, `refund.processed`, and `refund.failed`, uses the existing signature/event replay protections, and never lets a stale failed event downgrade a succeeded refund. See Razorpay's [refund webhook events](https://razorpay.com/docs/payments/refunds/subscribe-to-webhooks/).

The payment-maintenance job also reconciles locally pending/processing refunds every 60 seconds. Missing create responses are retried with the same provider idempotency key; known provider refund IDs are fetched directly.

## Operations summary

`GET /admin/orders/operations-summary` returns current counts for pending payments, paid-unfulfilled orders, processing/shipped/delivered orders, pending/failed refunds, and late captures on expired or cancelled orders that still need refund attention. It is an admin dashboard input, not a replacement for outbound alert delivery.

## Deployment

Run migration 009 before starting Phase 9 application instances:

```bash
npm run db:migrate:prod
npm run start:prod
```

Migration `009-admin-order-refund-operations` backfills zero-value payment refund ledgers, adds refund/order/restock indexes, and applies strict refund and cumulative-ledger database validators.

Before enabling Live Mode refunds:

1. subscribe the existing Razorpay webhook to `refund.created`, `refund.processed`, and `refund.failed`;
2. run a partial and full Test Mode refund;
3. verify duplicate admin retries return the same internal/provider refund;
4. verify a pending refund reaches its final state by webhook and reconciliation;
5. restrict OWNER accounts, rotate secrets, and monitor failed refunds and late captures;
6. verify the warehouse process does not mark an item returned until the physical item is received.

Carrier booking, label generation, and courier-provider API integration are not included; Phase 9 stores validated manual courier/tracking details.
