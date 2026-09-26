# Mobile communication channels

Phase 22 extends the transactional outbox to `SMS` and `WHATSAPP` without coupling commerce code
to a messaging vendor. Email, SMS, and WhatsApp become separate durable notification records with
separate idempotency keys, retry state, provider IDs, and admin visibility.

## Customer consent and eligibility

`orderUpdatesSms` and `orderUpdatesWhatsapp` are explicit opt-ins and both default to `false`.
Customers must verify a mobile number before enabling either preference. Each order, shipment,
refund, or return template reloads the current active customer and checks the current verified
mobile and preference before materializing a delivery. Guest-order snapshots are not treated as
mobile consent.

Mobile verification is the exception to the preference check because the customer explicitly
requests that security message for a proposed number. The six-digit OTP is HMAC-hashed in the
challenge record. A separately encrypted envelope is stored in the transactional outbox so that
delivery can retry without storing plaintext there. The pending notification temporarily contains
the code and its body is replaced by a removal marker immediately after successful delivery.
Production API responses never return the OTP; development and test responses do.

## Events

Opted-in customers can receive mobile updates for payment capture, shipment creation, shipped,
out-for-delivery, delivery exception, delivered, refund success, and every return lifecycle state.
The existing email templates remain unchanged. Unsupported events are acknowledged without
creating mobile delivery records.

## Provider adapter contract

Development uses `MESSAGE_DELIVERY_MODE=log`. It logs only delivery metadata—never destination or
message text—and returns a deterministic simulated provider ID.

Production mobile delivery uses one HTTPS adapter endpoint. The API sends:

```http
POST MESSAGE_PROVIDER_URL
Authorization: Bearer MESSAGE_PROVIDER_TOKEN
Idempotency-Key: <stable SHA-256 delivery key>
Content-Type: application/json
```

```json
{
  "channel": "SMS",
  "recipient": "+919876543210",
  "sender": "configured sender",
  "templateKey": "ORDER_FULFILLMENT_SHIPPED",
  "text": "Rich Culture: order RC-... has shipped..."
}
```

The adapter must return HTTP 2xx with `{ "messageId": "provider-id" }`. It owns vendor-specific
authentication, approved-template mapping, sender registration, and provider response translation.
The API deliberately exposes no provider credentials or payloads through admin endpoints.

## Environment

```dotenv
MESSAGE_DELIVERY_MODE=http
SMS_DELIVERY_ENABLED=true
WHATSAPP_DELIVERY_ENABLED=false
MESSAGE_PROVIDER_URL=https://messages.internal.example/v1/send
MESSAGE_PROVIDER_TOKEN=replace-with-a-secret-adapter-token
SMS_SENDER=your-approved-sender
WHATSAPP_SENDER=your-approved-whatsapp-sender
MESSAGE_PROVIDER_TIMEOUT_MS=10000
```

When a channel is enabled in production, startup fails unless HTTP mode, an HTTPS provider URL,
the provider token, and that channel's sender are configured. Disable unused channels explicitly.

## Operations

The admin Notifications page shows and filters `EMAIL`, `SMS`, and `WHATSAPP`. Failed and dead
deliveries use the existing OWNER-only audited retry endpoint. The provider boundary is at-least-
once: the stable `Idempotency-Key` lets the adapter deduplicate an ambiguous timeout after accepting
a message.

Migration `022-mobile-communication-channels` backfills both opt-ins to `false`, extends strict
customer and notification validators, and adds the channel/status admin index.
