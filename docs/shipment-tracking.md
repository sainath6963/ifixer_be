# Shipment tracking

Phase 21 adds a provider-neutral, one-shipment-per-order tracking lifecycle. The first provider is
`MANUAL`: an admin copies the courier and AWB from an external courier portal. No courier secret or
vendor-specific response is stored in the browser.

## Admin workflow

All endpoints require an authenticated `OWNER` or `STAFF` admin, a valid admin CSRF token, and the
current order version.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/admin/orders/:orderNumber/shipment` | Create the shipment while a paid order is `PROCESSING` |
| `PATCH` | `/api/v1/admin/orders/:orderNumber/shipment/status` | Append one customer-safe tracking event |

Creation requires a courier name and AWB/tracking number. An HTTPS tracking URL, service level, and
future estimated-delivery time are optional. Courier plus AWB is unique across orders.

Allowed transitions are:

```text
READY_TO_SHIP -> IN_TRANSIT
IN_TRANSIT -> OUT_FOR_DELIVERY | DELIVERY_EXCEPTION | DELIVERED
OUT_FOR_DELIVERY -> DELIVERY_EXCEPTION | DELIVERED
DELIVERY_EXCEPTION -> IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED
DELIVERED -> terminal
```

`IN_TRANSIT` synchronizes order fulfillment to `SHIPPED`. `DELIVERED` synchronizes fulfillment to
`DELIVERED` and lifecycle to `COMPLETED`. A delivery exception leaves fulfillment at `SHIPPED` and
appears in the admin operations alert count.

## Integrity and security

- Shipment and order state are stored in the same MongoDB aggregate and changed in one transaction.
- Order optimistic versions prevent two admins from appending conflicting events.
- Event times must be strictly chronological and cannot be more than five minutes in the future.
- Histories are bounded to 100 events per shipment.
- Paid or partially refunded orders may ship, but any pending refund blocks forward progress.
- Tracking URLs must use HTTPS; event messages and locations are length bounded.
- Every mutation writes an admin audit record and a transactional outbox event.
- Courier handover and delivery reuse the existing shipped/delivered customer email events.
- Admin notes are never included in customer shipment responses.

## Customer visibility

Customer-owned order responses include courier, AWB, service level, estimated delivery, tracking URL,
and chronological customer-safe events. Admin actor identifiers are omitted from customer responses.

## Migration 021

`021-shipment-tracking` backfills legacy embedded shipping data as `MANUAL`, derives its status from
the order fulfillment state, creates a system tracking event, installs shipment validators, and adds:

- `ix_orders_shipment_status_last_event`
- `uq_orders_courier_tracking_when_present`

The migration is forward-only. Back up MongoDB before production deployment and do not remove these
fields during an application rollback.

## Courier adapter boundary

This phase does not call Shiprocket, Delhivery, Blue Dart, or another vendor and does not fabricate a
label. A later adapter can create the external booking, persist the returned AWB/label reference, and
translate signed provider webhooks into the same guarded shipment transitions after the courier and
credentials are selected.
