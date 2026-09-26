# Transactional notification delivery

Phase 10 turns selected MongoDB outbox events into durable notifications. Phase 22 adds provider-neutral SMS and WhatsApp delivery. Business transitions still write state and their outbox event in one MongoDB transaction. A separate BullMQ worker materializes channel deliveries and sends them through SMTP or the configured mobile adapter.

## Events and recipients

| Outbox event | Recipient | Template purpose |
| --- | --- | --- |
| `ORDER_PAYMENT_CAPTURED` | Order customer email | Payment received and order confirmed |
| `ORDER_FULFILLMENT_SHIPPED` | Order customer email | Courier and tracking number |
| `ORDER_FULFILLMENT_DELIVERED` | Order customer email | Delivery confirmation |
| `ORDER_REFUND_SUCCEEDED` | Order customer email | Refund amount processed |
| `CUSTOMER_EMAIL_VERIFICATION_REQUESTED` | Account email | One-time email ownership confirmation |
| `CUSTOMER_EMAIL_CHANGE_REQUESTED` | Proposed new email | One-time email-change confirmation |
| `CUSTOMER_PASSWORD_RESET_REQUESTED` | Account email | One-time password reset link |
| `ORDER_LATE_PAYMENT_CAPTURED` | Every operations alert email | Manual refund review required |
| `ORDER_REFUND_FAILED` | Every operations alert email | Razorpay refund review required |
| `RETURN_REQUEST_REQUESTED` | Order customer and every operations alert email | Request acknowledgement and new-review alert |
| `RETURN_REQUEST_APPROVED` | Order customer email | Approval and customer-facing next steps |
| `RETURN_REQUEST_REJECTED` | Order customer email | Rejection and customer-facing reason |
| `RETURN_REQUEST_CANCELLED` | Order customer email | Customer cancellation confirmation |
| `RETURN_REQUEST_RECEIVED` | Order customer email | Inspection receipt and next step |
| `RETURN_REQUEST_COMPLETED` | Order customer email | Refund completion or replacement tracking |
| `RETURN_REQUEST_EXPIRED` | Order customer email | Replacement hold elapsed and stock released |
| `STOCK_ALERT_AVAILABLE` | Verified account email | Requested product option is available again |

Templates reload the current order/refund/return, active customer action, or verified stock-alert customer from MongoDB. Return event payloads are written only alongside the trusted state transition and preserve that transition's customer message/resolution snapshot even if a later state is reached before relay. Dynamic HTML is escaped. Account-action tokens and mobile OTPs use encrypted outbox envelopes, are verified against their source record before rendering, and their notification bodies are scrubbed after successful delivery. Customer events without an eligible channel destination or opt-in are acknowledged without creating that delivery. Unsupported outbox event types are also acknowledged. Return evidence contents, storage keys, and private content URLs are never included. Mobile-specific consent, provider, and security details are documented in [mobile-communications.md](mobile-communications.md).

## Delivery guarantees

Each recipient gets a SHA-256 delivery key derived from source event ID, channel, template key, and normalized recipient. Its unique MongoDB index makes repeated materialization idempotent. Outbox and notification workers atomically claim one record with a random lease token; a different worker cannot finalize that claim, and an abandoned five-minute lease can be recovered.

Failures use exponential backoff starting at 30 seconds and capped at six hours. The eighth failed attempt becomes `DEAD`. An `OWNER` can explicitly reset a failed/dead outbox event or notification after fixing the root cause. The action is audited.

SMTP is an at-least-once boundary, not an exactly-once protocol. If the SMTP server accepts a message but the connection fails before the application receives its response, a retry may send a duplicate. Rich Culture reuses a deterministic RFC Message-ID and delivery header on every retry, which helps provider-side deduplication but cannot guarantee it.

## Environment

Development and tests default to `log` mode. It records only the delivery key and template name and does not log recipients or message bodies. Production startup rejects `log` mode and requires at least one operations address.

```dotenv
EMAIL_DELIVERY_MODE=smtp
EMAIL_FROM_NAME=Rich Culture
EMAIL_FROM_ADDRESS=no-reply@your-domain.example
OPERATIONS_ALERT_EMAILS=owner@your-domain.example,operations@your-domain.example

SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USERNAME=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_CONNECTION_TIMEOUT_MS=10000
SMTP_MAX_CONNECTIONS=5
```

Use `SMTP_SECURE=true` for implicit TLS, normally on port 465. Port 587 normally starts unencrypted and upgrades using STARTTLS, so use `SMTP_SECURE=false` and keep `SMTP_REQUIRE_TLS=true`. The configured transport disables file and URL access from message content and reuses pooled SMTP connections. Nodemailer's official [SMTP transport](https://nodemailer.com/smtp) and [pooled SMTP](https://nodemailer.com/smtp/pooled) guides describe these settings.

SMTP credentials must be supplied together or both omitted for a trusted local relay. Keep credentials in the VPS secret environment, never in source control. Configure SPF, DKIM, and DMARC with the sending provider/domain before Live Mode, and test inbox placement outside the automated suite.

## Admin API

All routes require the admin access cookie, CSRF protection, and `Cache-Control: no-store`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/admin/notifications` | OWNER, STAFF | Paginate/filter deliveries by channel, status, template, recipient, or source event |
| `GET` | `/admin/notifications/operations-summary` | OWNER, STAFF | Counts for every outbox and notification state |
| `GET` | `/admin/notifications/outbox` | OWNER, STAFF | Paginate/filter outbox records without exposing event payloads |
| `POST` | `/admin/notifications/:notificationId/retry` | OWNER | Reset one `FAILED`/`DEAD` delivery |
| `POST` | `/admin/notifications/outbox/:outboxEventId/retry` | OWNER | Reset one `FAILED`/`DEAD` source event |

The notification list deliberately excludes stored message bodies. The outbox list excludes raw event payloads. Retry calls reject pending, processing, sent, or published records to avoid accidental duplicate delivery.

## Deployment and operations

Run all migrations through 015 before starting instances that deliver exchange expiry emails:

```bash
npm run build
npm run db:migrate:prod
npm run start:prod
```

Migration `010-reliable-notification-outbox` creates the notification collection, unique/worker/admin indexes, adds dead-letter and lease fields to the outbox contract, and applies strict validators. Migration `012-customer-account-recovery` adds the customer action source records used by the two account templates.

Migration `014-return-evidence-notifications` adds the evidence collection; return lifecycle outbox events use the existing reliable outbox and notification collections.

Migration `015-exchange-stock-reservations` adds the durable reservation state that produces `RETURN_REQUEST_EXPIRED`.

Migration `018-wishlist-stock-alerts` adds one-shot stock subscriptions. The notification sweep scans current inventory before relaying their deterministic `STOCK_ALERT_AVAILABLE` outbox events.

Migration `019-customer-profile-management` adds one-time new-email confirmation. Like reset and verification links, the delivered notification body is scrubbed after successful delivery.

Migration `022-mobile-communication-channels` adds explicit mobile opt-ins, channel-aware delivery records, encrypted OTP delivery, and the provider-neutral adapter boundary.

Before enabling production SMTP:

1. verify the sending domain and SPF/DKIM/DMARC records with the provider;
2. send every configured order, account, refund, and return event in staging and inspect text plus HTML versions;
3. temporarily reject a staging SMTP request and confirm `FAILED`, backoff, and recovery;
4. monitor `FAILED` and `DEAD` counts and alert outside this application;
5. keep Razorpay failed-refund and late-capture dashboard checks even if email delivery is healthy;
6. never treat an email's `SENT` state as proof that the recipient opened or received it.
