# Razorpay payments

Phase 8 binds each internal Phase 7 order to exactly one Razorpay order, verifies browser payment callbacks on the server, consumes signed webhooks idempotently, and commits reserved inventory only after a captured payment is confirmed.

The integration calls Razorpay's HTTPS REST API directly with Basic authentication and a bounded timeout. API and webhook secrets remain server-only. Only the public Razorpay key ID is returned to the customer frontend.

## Required Razorpay setup

Create Test Mode API keys and a separate webhook secret in the Razorpay Dashboard. Configure automatic capture in the Dashboard before accepting payments; an authorized payment is not treated as paid until Razorpay reports it as `captured`.

Configure this HTTPS webhook URL:

```text
https://YOUR_DOMAIN/api/v1/payments/razorpay/webhook
```

Subscribe to these events:

- `payment.authorized`
- `payment.captured`
- `payment.failed`
- `order.paid`
- `refund.created`
- `refund.processed`
- `refund.failed`

Razorpay documents server-side order creation in the [Orders API](https://razorpay.com/docs/api/orders/create/?preferred-country=IN), mandatory Checkout signature verification in the [Node.js integration flow](https://razorpay.com/docs/payments/server-integration/nodejs/integration-steps/?preferred-country=IN), and raw-body webhook verification/deduplication in [Validate and Test Webhooks](https://razorpay.com/docs/webhooks/validate-test/).

## Environment

```dotenv
RAZORPAY_KEY_ID=rzp_test_replace_me
RAZORPAY_KEY_SECRET=replace-with-razorpay-api-secret
RAZORPAY_WEBHOOK_SECRET=replace-with-independent-webhook-secret
RAZORPAY_CHECKOUT_NAME=Rich Culture
RAZORPAY_API_TIMEOUT_MS=10000
```

The API key secret and webhook secret must differ. Production rejects `dev-only-*` and `replace-with-*` values. Start in Razorpay Test Mode; switch to Live Mode credentials only after staging callbacks, webhooks, reconciliation, HTTPS, and operational alerts have been verified.

## Customer payment API

Both customer routes require the access cookie, customer CSRF token, and `Cache-Control: no-store` behavior.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/customer/orders/:orderNumber/payments/razorpay` | Create or recover the one provider order |
| `POST` | `/customer/orders/:orderNumber/payments/razorpay/verify` | Verify Checkout signature and fetch current provider payment state |

Payment initiation requires an `Idempotency-Key` header containing 16–160 safe ASCII characters. The backend never accepts amount or currency from the client. It reads the immutable internal order total and sends it to Razorpay in paise.

Example initiation response:

```json
{
  "checkout": {
    "paymentAttemptId": "66b5e4e6d81dd7fdde34a111",
    "provider": "RAZORPAY",
    "keyId": "rzp_test_example",
    "providerOrderId": "order_RB58MiP5SPFYyM",
    "amountInPaise": 249900,
    "currency": "INR",
    "checkoutName": "Rich Culture",
    "description": "Order RC-20260808-A1B2C3D4E5",
    "prefill": {
      "name": "Customer Name",
      "email": "customer@example.com",
      "contact": "+919876543210"
    },
    "expiresAt": "2026-08-08T10:30:00.000Z"
  }
}
```

Pass `keyId`, `providerOrderId`, `amountInPaise`, `currency`, description, and prefill values into Razorpay Standard Checkout. Never put `RAZORPAY_KEY_SECRET` or `RAZORPAY_WEBHOOK_SECRET` in frontend code.

After the Checkout success handler receives its three Razorpay fields, send:

```json
{
  "razorpayOrderId": "order_RB58MiP5SPFYyM",
  "razorpayPaymentId": "pay_RB58MiP5SPFYyM",
  "razorpaySignature": "64-character-hex-signature"
}
```

The backend computes the HMAC using the provider order ID already stored in MongoDB, not a client-selected order ID. A valid signature is necessary but is not sufficient to mark an order paid: the backend also fetches the payment from Razorpay and verifies provider order ID, amount, currency, and captured status.

## Provider-order idempotency

The internal order number is used as Razorpay's unique `receipt`. Payment initiation first checks MongoDB, then searches Razorpay by receipt, and only then attempts provider-order creation. If the outbound create request times out after Razorpay accepted it, retrying with the same customer idempotency key recovers the same provider order by receipt rather than exposing a second payable order.

One unique database index permits only one `RAZORPAY` payment record per internal order. Browser reloads may use a new initiation key and still receive that existing provider order. Reusing an earlier key for a different internal order returns `409 IDEMPOTENCY_KEY_REUSED`.

## Webhook security and ordering

Production bootstrap enables Nest raw-body capture. The webhook handler:

1. requires `X-Razorpay-Signature` and `X-Razorpay-Event-Id`;
2. verifies HMAC-SHA256 against the exact raw request bytes before parsing;
3. stores the payload SHA-256 hash and unique provider event ID;
4. rejects an event ID replayed with different bytes;
5. safely accepts exact duplicate deliveries;
6. validates event type against the embedded payment state;
7. processes authorized, captured, and failed transitions without allowing a later stale event to downgrade `CAPTURED`.

Unsupported, validly signed events are stored as `IGNORED`. Events for Razorpay orders not owned by this application are also ignored. Failed internal processing returns a non-2xx response so Razorpay can retry.

## Inventory and order transitions

`payment.authorized` changes the payment attempt to `AUTHORIZED` and the internal financial status to `PENDING`; it does not sell inventory.

`payment.failed` records the latest provider failure and moves a pending authorization back to `UNPAID`. The normal Phase 7 expiry worker can then release inventory when the payment window has elapsed.

A captured payment on an active `PENDING_PAYMENT` order commits one MongoDB transaction containing:

- payment attempt → `CAPTURED`;
- order lifecycle → `CONFIRMED`;
- financial status → `PAID`;
- every reservation → `COMMITTED`;
- any coupon reservation → `REDEEMED`, with held and paid counters moved atomically;
- inventory `onHand -= quantity`;
- inventory `reserved -= quantity`;
- inventory `sold += quantity`;
- one unique `PAYMENT_CAPTURE_COMMIT` movement per variant;
- audit and `ORDER_PAYMENT_CAPTURED` outbox events.

Duplicate browser verification, duplicate `payment.captured`, and the matching `order.paid` event cannot commit stock twice.

## Late captured payments

Razorpay orders cannot be cancelled merely because the internal reservation expired. A customer could complete an old provider checkout after the internal order became `EXPIRED` or `CANCELLED`.

For that case the backend records the attempt as `CAPTURED` and the financial status as `PAID`, but it does not decrement stock or revive fulfillment. It emits `ORDER_LATE_PAYMENT_CAPTURED` with `refundRequired: true`. Phase 9 exposes this in the operations summary and lets an `OWNER` issue an idempotent full refund without reviving fulfillment.

## Reconciliation

The `payment-maintenance` BullMQ scheduler runs every 60 seconds. It checks up to 50 non-terminal payment records and 50 pending/processing refunds older than 15 seconds. It recovers missing provider orders/refunds using stable receipts and idempotency keys, fetches Razorpay state, and applies the same transition paths used by webhooks and synchronous API responses.

Webhooks remain the main asynchronous signal. Reconciliation covers dropped browser responses, delayed/missing payment or refund webhooks, and the small failure window between provider success and local persistence. Phase 9 refund operations are documented in [admin-order-operations.md](admin-order-operations.md).

## Deployment and verification

Deploy migration `008-razorpay-payment-constraints` before Phase 8 application instances:

```bash
npm run db:migrate:prod
npm run start:prod
```

The automated suite uses a fake provider gateway and never charges money. Before Live Mode:

1. run a real Razorpay Test Mode payment through the customer frontend;
2. confirm both browser verification and webhook delivery;
3. test duplicate webhook delivery and a failed payment;
4. confirm Dashboard automatic capture;
5. confirm the reconciliation worker and late-payment alert path;
6. run partial/full Test Mode refunds and verify `refund.processed`/`refund.failed` handling;
7. rotate test credentials to Live Mode credentials through the VPS secret manager/environment.
