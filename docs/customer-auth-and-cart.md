# Customer authentication and persistent cart

Phase 6 adds customer accounts, isolated browser sessions, and a server-managed guest/authenticated cart. Phase 7 checkout/order behavior is documented separately in [checkout-and-orders.md](checkout-and-orders.md).

## Browser authentication flow

Customer credentials and session cookies are separate from the admin security domain. The customer JWTs use independent secrets and the `rich-culture-customer` audience, so an admin token cannot authenticate a customer route and vice versa.

1. Call `GET /api/v1/customer/auth/csrf` with browser credentials enabled.
2. Keep the returned `rc_customer_csrf` cookie and send the response token in `X-CSRF-Token` on every customer/cart mutation.
3. Register or log in. Access and rotating refresh JWTs are returned only as HttpOnly cookies.
4. Call `POST /customer/auth/refresh` before/after access expiry. Each successful refresh invalidates the previously presented refresh token.
5. A reused refresh token revokes that session family. The browser must log in again.

Authentication responses use `Cache-Control: no-store`. The application must not copy cookies or tokens into `localStorage` or `sessionStorage`.

## Customer auth endpoints

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/customer/auth/csrf` | Public | Issue signed customer-scoped CSRF token and cookie |
| `POST` | `/customer/auth/register` | CSRF | Create account and live session; merge guest cart |
| `POST` | `/customer/auth/login` | CSRF | Start session; merge guest cart |
| `POST` | `/customer/auth/refresh` | Refresh cookie + CSRF | Atomically rotate refresh/access cookies |
| `POST` | `/customer/auth/logout` | Refresh cookie + CSRF | Revoke current session when present and clear cookies |
| `POST` | `/customer/auth/logout-all` | Access cookie + CSRF | Revoke all customer sessions |
| `GET` | `/customer/auth/me` | Access cookie | Return the live customer identity |
| `PATCH` | `/customer/auth/password` | Access cookie + CSRF | Change password and revoke every session |
| `POST` | `/customer/auth/verification-email` | Access cookie + CSRF | Queue verification instructions when needed |
| `POST` | `/customer/auth/verify-email` | CSRF | Consume a one-time verification token |
| `POST` | `/customer/auth/forgot-password` | CSRF | Request reset instructions with a generic response |
| `POST` | `/customer/auth/reset-password` | CSRF | Consume a one-time reset token and revoke all sessions |

Registration requires a normalized email, name, and a 12–128 character password. Passwords use the same Argon2id work factors as admin accounts but customer token secrets and sessions remain separate. Login failures return the generic `CUSTOMER_CREDENTIALS_INVALID` response, and authentication endpoints have stricter route-specific throttles.

OTP/mobile login and customer email/mobile changes require additional product decisions and remain deferred. Saved-address behavior is documented in [customer-saved-addresses.md](customer-saved-addresses.md), and the Phase 12 email/recovery lifecycle is documented in [customer-account-recovery.md](customer-account-recovery.md).

## Cookie scope

| Cookie | HttpOnly | Path | Purpose |
| --- | --- | --- | --- |
| `rc_customer_access` | Yes | `/api/v1` | Short-lived customer access JWT |
| `rc_customer_refresh` | Yes | `/api/v1/customer/auth` | Rotating refresh JWT |
| `rc_customer_csrf` | No | `/api/v1` | Double-submit CSRF token read by the frontend |
| `rc_cart` | Yes | `/api/v1` | Random guest-cart credential; only its HMAC hash is stored in MongoDB |

Production cookies require HTTPS and `Secure=true`; SameSite/domain settings remain environment controlled.

## Cart endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/cart` | Read the guest or authenticated cart with current catalog data |
| `PUT` | `/cart/items/:variantId` | Set the exact quantity for a product variant |
| `DELETE` | `/cart/items/:variantId` | Remove one variant |
| `DELETE` | `/cart` | Clear every cart item |

All responses use `Cache-Control: no-store`. Read works without an account. Mutations require the customer CSRF token; a guest cart cookie is created on the first successful `PUT`.

Example mutation:

```json
{
  "productId": "66b5e4e6d81dd7fdde34a111",
  "quantity": 2,
  "expectedVersion": 3
}
```

`expectedVersion` is optional for simple clients but recommended. A stale version returns `409 CART_VERSION_CONFLICT`; reload the cart and ask the user to retry. A cart supports at most 50 distinct variants and quantity `1..10` per item.

## Pricing and availability rules

The client never submits a price. Each mutation and read loads current active/published products, active variants, media, and inventory in batches. Responses calculate integer-paise unit prices, line totals, and subtotal on the server.

Cart item availability is:

- `AVAILABLE`: current available stock satisfies the cart quantity
- `INSUFFICIENT_STOCK`: product/variant is saleable but current available stock is lower than requested
- `UNAVAILABLE`: product was unpublished/archived or the variant was deactivated

Exact `onHand`, `reserved`, `sold`, filesystem storage keys, guest-token hashes, and internal versions are never exposed. `readyForCheckout` is only an advisory cart validation. Cart writes do not reserve inventory; Phase 7 checkout re-prices and reserves stock transactionally while creating the internal unpaid order, and Phase 8 handles its Razorpay payment.

## Persistence and merge behavior

- Guest carts expire after 30 days.
- Customer carts expire after 365 days of inactivity.
- MongoDB TTL indexes remove expired carts/sessions eventually; application queries enforce `expiresAt` immediately and safely recycle an expired customer cart before the TTL monitor deletes it.
- One partial unique index allows only one active cart per customer.
- Guest token hashes are unique and the raw credential exists only in the HttpOnly cookie.
- Register/login/refresh claims the current guest cart. Matching variants have quantities added up to the per-item cap; remaining distinct variants are merged up to the cart limit.

## Migration and production configuration

Migration `006-customer-auth-cart-constraints` creates customer-session/cart collections, strict validators, unique indexes, and TTL indexes. Deploy it before starting Phase 6 application instances:

```bash
npm run db:migrate:prod
npm run start:prod
```

Add three independent secrets of at least 32 characters:

```dotenv
CUSTOMER_JWT_ACCESS_SECRET=replace-with-independent-random-secret
CUSTOMER_JWT_REFRESH_SECRET=replace-with-another-independent-random-secret
CUSTOMER_TOKEN_PEPPER=replace-with-independent-random-pepper
```

Customer access/refresh secrets must differ from one another and from both admin JWT secrets. Changing them invalidates existing customer sessions/carts as appropriate.
