# Checkout, inventory reservations, and customer orders

Phase 7 converts an authenticated customer's active cart into an unpaid order with a temporary inventory reservation. Cart conversion, price snapshots, stock counters, reservation rows, movement rows, the order, audit log, and outbox event are committed in one MongoDB transaction.

This phase creates the internal `PENDING_PAYMENT` order. Phase 8 now binds it to exactly one Razorpay order/payment record as documented in [razorpay-payments.md](razorpay-payments.md).

## Customer API flow

All routes require the customer access cookie. Every `POST` also requires the customer CSRF cookie/token pair described in [customer-auth-and-cart.md](customer-auth-and-cart.md). Responses use `Cache-Control: no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/checkout/preview` | Reprice and validate the active cart without reserving stock |
| `POST` | `/checkout/orders` | Create one unpaid order and reserve stock atomically |
| `GET` | `/customer/orders?page=1&limit=20` | List the current customer's orders newest first |
| `GET` | `/customer/orders/:orderNumber` | Read one current-customer-owned order |
| `POST` | `/customer/orders/:orderNumber/cancel` | Cancel an unpaid pending order and release its stock |

Preview and order creation accept the same server-validated body:

```json
{
  "expectedCartVersion": 3,
  "couponCode": "WELCOME10",
  "shippingAddress": {
    "fullName": "Customer Name",
    "phone": "+919876543210",
    "line1": "42 Example Road",
    "line2": "Near Example Landmark",
    "city": "Pune",
    "state": "Maharashtra",
    "postalCode": "411001",
    "countryCode": "IN"
  }
}
```

`couponCode` is optional and normalized to uppercase. Only Indian addresses are accepted in this phase. Prices, discounts, tax, shipping, currency, totals, product names, SKU values, and payment status are never accepted from the client. The backend reloads the active product, variant, current price, promotion eligibility, and inventory inside the transaction.

## Idempotent order creation

`POST /checkout/orders` requires an `Idempotency-Key` header containing 16–160 safe ASCII characters. Generate a fresh unpredictable key for each checkout attempt and keep it while retrying the exact same request.

The server stores both the unique key and a SHA-256 request fingerprint. A retry with the same customer, cart version, normalized address, and normalized coupon code returns the original order without creating another reservation. Reusing the key for a changed request or another customer returns `409 IDEMPOTENCY_KEY_REUSED`.

An ambiguous client timeout should be retried using the same key. Do not generate a new key until the customer intentionally starts a new checkout attempt.

## Atomic inventory invariant

Order creation uses snapshot reads and majority writes on a MongoDB replica set. For each variant, inventory is conditionally incremented only when:

```text
onHand - reserved >= requested quantity
```

Variants are locked in stable ObjectId order to reduce transaction conflicts. If any item is unavailable, MongoDB aborts all writes: there is no partial order, reservation, movement, outbox event, audit record, or converted cart. Concurrent checkouts can therefore produce only as many successful reservations as physical stock permits.

One successful transaction creates:

- an immutable customer, address, item, price, and totals snapshot in `orders`;
- active `inventory_reservations` expiring with the payment window;
- `CHECKOUT_RESERVATION` inventory movements;
- an `ORDER_PENDING_PAYMENT_CREATED` outbox event;
- a customer audit record;
- a `CONVERTED` source cart.

When a coupon is present, the transaction also conditionally allocates one global usage slot, creates one active customer redemption reservation, and stores an immutable coupon/discount snapshot on the order. A competing checkout cannot exceed the campaign limit or use the same coupon twice for one customer.

MongoDB validators independently reject inconsistent item line totals, subtotal, grand-total breakdowns, unsafe integers, missing checkout identifiers, and invalid statuses.

## Cancellation and automatic expiry

Customers may cancel only an order that is both `PENDING_PAYMENT` and `UNPAID`. Cancellation changes the lifecycle to `CANCELLED`, fulfillment to `CANCELLED`, finalizes active inventory reservations as `RELEASED`, decrements the inventory `reserved` counter, releases any reserved coupon slot, and records exactly one release movement/outbox transition. Repeating the cancellation is safe and returns the already-cancelled order.

The `checkout-maintenance` BullMQ queue registers one job scheduler that runs every 30 seconds. Each run processes up to 100 unpaid pending orders whose `paymentExpiresAt` has passed. It changes them to `EXPIRED`, marks reservations `EXPIRED`, and releases stock plus coupon allocation transactionally. Queue retries and duplicate executions are safe because state filters and unique transition indexes prevent a second release.

The reservation period comes from the private `checkout.inventoryReservationMinutes` store setting. Valid values are integer minutes from 1 through 60; the safe fallback is 15 minutes.

## Customer-safe order response

The API returns order snapshots, integer-paise totals, lifecycle/financial/fulfillment status, expiry time, `paymentReady`, and customer-safe courier/tracking data after shipment. It does not expose the idempotency key/hash, source-cart ID, filesystem storage keys, exact inventory counters, audit actors, admin notes, or internal provider data. Order detail queries always include the current customer ID; an order owned by somebody else returns `404 ORDER_NOT_FOUND`.

Common checkout errors are:

| Status/code | Meaning |
| --- | --- |
| `400 IDEMPOTENCY_KEY_INVALID` | Missing or malformed create-order key |
| `409 CART_EMPTY` | No active non-empty customer cart exists |
| `409 CART_VERSION_CONFLICT` | Cart changed after the displayed preview |
| `409 CHECKOUT_ITEMS_UNAVAILABLE` | Product, variant, or requested stock is no longer saleable |
| `409 IDEMPOTENCY_KEY_REUSED` | Key belongs to a different request/customer |
| `409 COUPON_NOT_AVAILABLE` | Code is inactive, outside its window, or exhausted |
| `409 COUPON_MINIMUM_NOT_MET` | Current subtotal is below the campaign minimum |
| `409 COUPON_ALREADY_USED` | Customer already has a held or paid use of this code |
| `409 ORDER_CANNOT_BE_CANCELLED` | Order is no longer unpaid and pending |
| `404 ORDER_NOT_FOUND` | Order is missing or belongs to a different customer |

## Deployment

Run all migrations through `016-coupon-promotions` before starting the current application:

```bash
npm run db:migrate:prod
npm run start:prod
```

MongoDB must be a replica set because checkout correctness depends on multi-document transactions. Redis must be persistent and available for the BullMQ scheduler. Running the existing development seed retains or inserts the private 15-minute reservation setting; production can manage the setting directly in MongoDB under controlled operations.

## Payment boundary

Phase 8 creates a Razorpay order from the trusted internal `grandTotalInPaise`, persists provider attempts, returns only public checkout fields, verifies the browser signature on the server, ingests signed raw-body webhooks idempotently, and atomically commits captured inventory. Payment truth comes from verified server/provider data; a browser success callback alone never marks an order paid.
