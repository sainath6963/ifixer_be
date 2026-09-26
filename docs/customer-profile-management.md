# Customer profile management

Phase 19 adds authenticated profile editing, verified contact changes, explicit communication preferences, safe account deactivation, and read-only admin customer lookup.

## Customer API

All authenticated routes require the customer access cookie, customer-scoped CSRF token, and return `Cache-Control: no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `PATCH` | `/api/v1/customer/profile` | Change the customer's name using `expectedVersion` optimistic concurrency |
| `PATCH` | `/api/v1/customer/profile/preferences` | Save email preferences and explicit SMS/WhatsApp order-update opt-ins |
| `POST` | `/api/v1/customer/profile/email-change` | Verify the current password and send a link to the new email |
| `POST` | `/api/v1/customer/auth/change-email` | Publicly consume the one-time email-change link |
| `POST` | `/api/v1/customer/profile/mobile-change` | Verify the current password and create a mobile OTP challenge |
| `POST` | `/api/v1/customer/profile/mobile-change/confirm` | Consume the OTP and set a verified mobile number |
| `POST` | `/api/v1/customer/profile/deactivate` | Disable the account after password and explicit-text confirmation |

Name, mobile, and preference writes carry the latest customer `version`. A stale write returns `CUSTOMER_PROFILE_CONFLICT`; the client must reload instead of silently overwriting a change from another session.

## Email-change security

An email-change request requires the current password and rejects an address already assigned to another customer. The current account email is not changed when the request is created. A one-time `EMAIL_CHANGE` action token is HMAC-hashed in MongoDB and its encrypted envelope enters the transactional outbox. The notification is sent to `targetEmail`, never to the old account email.

The browser removes the token from history and waits for the user to press **Confirm new email**, so an email scanner cannot consume the initial GET. Confirmation marks the new email verified, revokes every customer session, invalidates every remaining action token, and requires a fresh sign-in with the new email.

## Mobile OTP delivery boundary

Mobile challenges store only an HMAC-SHA-256 code hash, expire after ten minutes by default, permit five failed attempts, enforce a resend cooldown, and allow only one active challenge per customer. The mobile number is not updated until the code is consumed. Unique customer-mobile enforcement is checked again during confirmation to close request/confirm races.

In development and tests, the API returns `developmentOtp` so the flow can be exercised without an SMS bill. It is never logged or stored as plaintext in the challenge or outbox. Production requires the HTTPS mobile-provider adapter and never returns a debug code. Delivery, retries, and the encrypted OTP envelope are documented in [mobile-communications.md](mobile-communications.md).

```dotenv
CUSTOMER_MOBILE_OTP_TTL_SECONDS=600
CUSTOMER_MOBILE_OTP_COOLDOWN_SECONDS=60
CUSTOMER_MOBILE_OTP_MAX_ATTEMPTS=5
```

## Preferences and deactivation

`marketingEmail` defaults to `false` (no inferred marketing consent). `backInStockEmail` defaults to `true` to preserve the existing customer-requested stock-alert behavior. `orderUpdatesSms` and `orderUpdatesWhatsapp` both default to `false` and require a verified mobile before they can be enabled. Turning back-in-stock email off atomically cancels all active alerts; every notification renderer re-checks current eligibility.

Deactivation is reversible at the data layer but is not exposed as self-service reactivation. It preserves orders and audit records, sets the account to `DISABLED`, revokes sessions/action tokens/mobile challenges, and cancels stock alerts. Deactivation is blocked while the customer has an active order or return request. It is not hard deletion and should not be represented as statutory data erasure.

## Admin API

`OWNER` and `STAFF` can use:

- `GET /api/v1/admin/customers?page=&limit=&search=&status=`
- `GET /api/v1/admin/customers/:customerId`

The responses contain identity/verification state, preferences, counts, paid-order summary, and recent orders. They never expose password hashes, session tokens, action-token payloads, OTP hashes, full saved addresses, or email bodies. The current phase is read-only; admin account activation/deactivation is intentionally not available.

## Migration

Migration `019-customer-profile-management` backfills safe preference defaults, extends the customer/action-token validators, creates the mobile-challenge collection, and applies unique/query/TTL indexes.

Migration `022-mobile-communication-channels` adds the two mobile opt-ins and the durable OTP/mobile delivery path.

```bash
npm run build
npm run db:migrate:prod
npm run start:prod
```
