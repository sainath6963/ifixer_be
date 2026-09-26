# Admin business analytics

Phase 20 adds read-only business reporting for `OWNER` and `STAFF`. It reports money from provider-backed payment/refund transitions rather than mutable order labels.

## API

Both endpoints require a live admin access cookie and return `Cache-Control: no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/admin/analytics` | KPIs, comparison period, trend, top products, and current low-stock signals |
| `GET` | `/api/v1/admin/analytics/export.csv` | Spreadsheet-safe trend export for the same query |

Query parameters:

- `dateFrom=YYYY-MM-DD` and `dateTo=YYYY-MM-DD` are an all-or-nothing inclusive range.
- Calendar boundaries use `Asia/Kolkata`, which has no daylight-saving transition.
- The default is the latest 30 India business days.
- Ranges are limited to 366 days.
- `granularity=AUTO|DAY|WEEK|MONTH`; automatic grouping is daily through 45 days, weekly through 180 days, then monthly. Explicit daily grouping is limited to 90 days.

Invalid or incomplete ranges return `ANALYTICS_DATE_RANGE_INVALID`. The browser owns filters in the URL, so a report can be refreshed or shared between authorized admins without hidden local state.

## Metric definitions

- **Gross captured**: sum of `payment_attempts.amountInPaise` whose durable status is `CAPTURED` and whose `capturedAt` falls inside the period.
- **Settled refunds**: sum of `refunds.amountInPaise` whose durable status is `SUCCEEDED` and whose `processedAt` falls inside the period.
- **Net revenue**: gross captured in the period minus refunds processed in the period. This is period cash movement; a refund may relate to a sale captured in an earlier period.
- **Paid orders**: captured payment-attempt count. The database permits one Razorpay attempt per internal order.
- **Average order value**: gross captured divided by paid orders, rounded to the nearest paise.
- **New customers**: customer records created in the period.

The comparison window immediately precedes the selected period and has exactly the same number of business days. If the comparison value is zero, a non-zero current value is labelled `new` and no invented percentage is returned.

Top products come from immutable item snapshots on orders joined to captured payments. Their item sales include item-level discounts but do not allocate order-level coupon/shipping/tax amounts across products. Low stock is a current operational signal, not a historical period metric: an active, non-archived option appears when `onHand - reserved <= reorderPoint`.

## CSV safety

The export uses UTF-8 with a BOM for spreadsheet compatibility, quotes every cell, doubles embedded quotes, reports INR decimal values derived from integer paise, and uses a server-controlled filename. It contains period aggregates only—no customer identity, address, payment-provider identifier, or admin audit data.

## Database and deployment

Migration `020-admin-business-analytics` adds bounded range-query indexes:

- `payment_attempts(status, capturedAt)`
- `refunds(status, processedAt)`
- `customers(createdAt)`

Run the normal release sequence:

```bash
npm run build
npm run db:migrate:prod
npm run start:prod
```

After deployment, compare one known Razorpay capture and settled refund against the Razorpay dashboard for an identical India date range. Analytics supports operational decisions but does not replace tax/GST accounting, settlement reconciliation, or a financial ledger.
