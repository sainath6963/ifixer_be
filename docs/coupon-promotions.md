# Coupon promotions

Phase 16 adds server-authoritative coupon campaigns without trusting browser totals. Campaigns are global order-level promotions in this phase; product/category targeting and automatic no-code discounts remain deferred.

## Admin API and roles

All routes require admin cookie authentication, the admin CSRF pair, and return `Cache-Control: no-store`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/admin/coupons?page=1&limit=25&status=ACTIVE&search=welcome` | OWNER/STAFF | Search campaigns and usage |
| `GET` | `/admin/coupons/:couponId` | OWNER/STAFF | Read one campaign |
| `POST` | `/admin/coupons` | OWNER | Create a draft campaign |
| `PATCH` | `/admin/coupons/:couponId` | OWNER | Update terms/status using `expectedVersion` |

Creation is draft-first. A campaign must explicitly move to `ACTIVE`; active campaigns can be scheduled with a future `startsAt`, paused immediately, or permanently archived. An archived campaign cannot be reactivated. Discount code/amount/type terms lock after the first held or paid allocation, while status, window, minimum subtotal and a safe usage-limit increase remain operationally editable.

Supported terms:

- `PERCENTAGE` from 1–90%, with an optional maximum discount;
- `FIXED_AMOUNT` in integer paise;
- minimum subtotal;
- start/end timestamps;
- a global limit from 1–1,000,000;
- exactly one held-or-paid use per customer.

The admin response derives `DRAFT`, `SCHEDULED`, `LIVE`, `PAUSED`, `ENDED`, `EXHAUSTED`, or `ARCHIVED` availability and reports held, paid, and remaining uses. STAFF access is read-only. Every OWNER create/update is audited.

## Checkout and amount safety

The customer optionally sends `couponCode` with both `/checkout/preview` and `/checkout/orders`. The backend normalizes it, reloads the active campaign, validates its window, minimum spend, global capacity and customer history, then computes the exact discount in integer paise. Percentage arithmetic uses integer math. A promotion cannot reduce the Razorpay payable total below ₹1.

Preview is advisory. Order creation repeats eligibility inside the same MongoDB transaction used for inventory and order creation. The transaction atomically:

1. conditionally increments `coupons.reservedCount` only below `usageLimit`;
2. creates a `RESERVED` redemption linked to coupon, customer, and order;
3. enforces one active redemption per coupon/customer with a unique partial index;
4. stores code, campaign name, configured value and applied discount in the order snapshot;
5. uses the discounted `grandTotalInPaise` for the Razorpay order.

If any inventory or coupon write fails, the whole checkout rolls back. Coupon code is included in the checkout idempotency fingerprint, so a retry returns the original order and changing the code with the same key is rejected.

## Redemption lifecycle

| Order event | Coupon transition |
| --- | --- |
| Unpaid order created | counter `reserved +1`; redemption `RESERVED` |
| Razorpay capture on active order | counter `reserved -1`, `redeemed +1`; redemption `REDEEMED` |
| Customer cancellation | counter `reserved -1`; redemption `RELEASED` |
| Payment-window expiry | counter `reserved -1`; redemption `RELEASED` |
| Late capture after cancellation/expiry | remains `RELEASED`; existing late-capture refund path applies |

Every transition runs in the same transaction as its order/inventory transition and filters the current redemption state, making duplicate browser verification, webhooks, cancellations, and workers safe.

## Persistence and deployment

Migration `016-coupon-promotions` creates `coupons` and `coupon_redemptions`, named uniqueness/window/expiry indexes, strict collection validators, and the order coupon-snapshot invariant.

Before deploying Phase 16 application containers:

```bash
npm run db:migrate:prod
npm run start:prod
```

MongoDB must remain in replica-set mode. After deployment, create a low-limit Test Mode coupon, validate preview and order creation, complete one Razorpay Test Mode payment, cancel a second order with another code, and confirm held/paid counters in the admin promotions screen.
