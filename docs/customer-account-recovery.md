# Customer email verification and account recovery

Phase 12 adds non-blocking email verification plus a secure forgot/reset-password lifecycle. Registration creates a signed-in account and transactionally queues verification email; an unverified customer can still shop, then request another link from the account page.

## Endpoints

Every mutation requires the customer-scoped CSRF cookie and matching `X-CSRF-Token`. Responses use `Cache-Control: no-store`.

| Method | Path | Authentication | Result |
| --- | --- | --- | --- |
| `POST` | `/api/v1/customer/auth/verification-email` | Customer access cookie | HTTP 202 and a generic resend message |
| `POST` | `/api/v1/customer/auth/verify-email` | Public one-time token | HTTP 204 and `emailVerified=true` |
| `POST` | `/api/v1/customer/auth/forgot-password` | Public email input | HTTP 202 with the same response for known and unknown accounts |
| `POST` | `/api/v1/customer/auth/reset-password` | Public one-time token | HTTP 204, password changed, all sessions revoked |

`forgot-password` always returns:

```json
{
  "message": "If an eligible account exists, reset instructions will be sent."
}
```

This contract prevents the response body/status from disclosing registered email addresses. Route and persistent resend cooldowns limit abuse. Delivery timing should still be monitored and rate-limited at the public reverse proxy.

## Token security

- Tokens contain 256 random bits and are accepted only in URL-safe base64 form.
- MongoDB stores only the HMAC-SHA-256 token hash in `customer_action_tokens`.
- The raw token is AES-256-GCM encrypted before entering the transactional outbox; the key is purpose-derived from `CUSTOMER_TOKEN_PEPPER`.
- Only one active token per customer and purpose is permitted by a partial unique index.
- Issuing a newer token invalidates the prior active token.
- Verification and reset use an atomic one-time claim. Reuse, expiry, invalidation, or malformed input returns `CUSTOMER_ACTION_TOKEN_INVALID` without revealing which condition occurred.
- Verification defaults to 24 hours; password reset defaults to 30 minutes. MongoDB TTL cleanup eventually removes expired records, while application queries reject them immediately.
- Pending delivery temporarily contains the actionable URL. After successful SMTP delivery, the notification worker replaces sensitive email bodies with a removal marker. Admin APIs never expose outbox payloads or notification bodies.

Password reset rejects reuse of the existing password, marks the same account email as verified, invalidates every outstanding customer action token, and revokes all active sessions with reason `PASSWORD_RESET`. The customer must sign in again with the new password.

## Browser behavior

Email links open `/verify-email?token=...` or `/reset-password?token=...` on `PUBLIC_STOREFRONT_URL`. The React page immediately removes the token query from browser history while retaining it only in component memory.

Verification is not performed by the initial HTTP GET. The customer must press **Verify email**, preventing common email security scanners and link-preview bots from consuming the one-time token. Recovery pages are marked `noindex`.

## Email delivery

The existing transactional outbox emits:

- `CUSTOMER_EMAIL_VERIFICATION_REQUESTED`
- `CUSTOMER_EMAIL_CHANGE_REQUESTED` (documented in [customer-profile-management.md](customer-profile-management.md))
- `CUSTOMER_PASSWORD_RESET_REQUESTED`

The notification relay validates the encrypted token against the stored HMAC and reloads the active customer/token before rendering. Invalidated, expired, mismatched, or deleted-account events publish without creating an email.

SMTP retry/dead-letter behavior and OWNER retry controls remain those documented in [notification-delivery.md](notification-delivery.md).

## Configuration and deployment

```dotenv
PUBLIC_STOREFRONT_URL=https://shop.example.com
CUSTOMER_EMAIL_VERIFICATION_TTL_SECONDS=86400
CUSTOMER_PASSWORD_RESET_TTL_SECONDS=1800
CUSTOMER_AUTH_EMAIL_COOLDOWN_SECONDS=60
```

Production requires an HTTPS storefront URL and SMTP delivery. `CUSTOMER_TOKEN_PEPPER` is also the envelope key source; rotating it invalidates active customer sessions and outstanding action links, so treat rotation as a planned security event.

Migration `012-customer-account-recovery` creates the action-token collection, strict validator, unique active-token constraint, query index, TTL index, and customer `emailVerifiedAt` validator support:

```bash
npm run build
npm run db:migrate:prod
npm run start:prod
```

Existing customers remain unverified. They can sign in and request verification from the account page; do not mark historical emails verified without a separately approved ownership-validation process.
