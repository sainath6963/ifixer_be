# Admin Authentication and Authorization

## Security model

The admin UI authenticates with cookies; bearer tokens are not returned in response bodies or made available to browser JavaScript.

- Access JWT: HttpOnly cookie, 15-minute lifetime.
- Refresh JWT: HttpOnly cookie, 30-day lifetime, scoped to `/api/v1/admin/auth`.
- CSRF token: signed double-submit cookie plus `X-CSRF-Token` header on every unsafe admin-auth request.
- Password hashing: Argon2id.
- Session state: every protected request checks the live MongoDB session, its generation, expiry, revocation state, the active admin account, and current roles.
- Rotation: a successful refresh replaces the stored refresh hash and increments its generation atomically. Reuse of an older token revokes that session family.
- RBAC: admin endpoints can require `OWNER` and/or `STAFF` using `AdminAccessGuard`, `AdminRolesGuard`, and `@AdminRoles(...)`.
- Audit: login, rotation, reuse detection, password changes, and revocation events are stored without plaintext credentials, tokens, email addresses from failed attempts, or IP addresses.

Production must set independent high-entropy values for the two JWT secrets, token pepper, and CSRF secret. Production startup rejects development placeholders and insecure cookies.

## Initial owner bootstrap

Run migrations first. Then provide the three bootstrap values through the process environment and run the one-time command:

```bash
npm run db:migrate
npm run admin:bootstrap
```

For a built production release:

```bash
npm run db:migrate:prod
npm run admin:bootstrap:prod
```

The operation uses a MongoDB transaction to create the owner, a permanent bootstrap marker, and an audit record. It refuses to run if an owner or marker already exists. Remove `BOOTSTRAP_ADMIN_PASSWORD` from the VPS environment immediately after success; never commit it or pass it as a command-line argument.

## Browser flow

All browser calls must use credentials (for example, Fetch `credentials: "include"`).

1. `GET /api/v1/admin/auth/csrf` and retain `csrfToken` from the JSON response.
2. For `POST`, `PATCH`, `PUT`, and `DELETE` admin-auth calls, send that value as `X-CSRF-Token`; the browser sends its matching cookie.
3. `POST /api/v1/admin/auth/login` with email and password. The API sets access and refresh cookies.
4. Use `GET /api/v1/admin/auth/me` to restore the signed-in UI state.
5. On access expiry, call `POST /api/v1/admin/auth/refresh` with the CSRF header. Only one refresh request should be in flight per browser session.
6. Use `POST /api/v1/admin/auth/logout` for the current session or `POST /api/v1/admin/auth/logout-all` to revoke all sessions.

If refresh returns `401`, clear local admin UI state and require a fresh login. Do not automatically retry the same refresh token: reuse detection intentionally revokes the session.

## Endpoints

| Method | Path | Access requirement | Purpose |
| --- | --- | --- | --- |
| GET | `/admin/auth/csrf` | Public | Issue CSRF cookie/token pair |
| POST | `/admin/auth/login` | CSRF | Create session; 5 attempts/minute |
| POST | `/admin/auth/refresh` | CSRF + refresh cookie | Rotate token pair |
| POST | `/admin/auth/logout` | CSRF | Revoke current session |
| POST | `/admin/auth/logout-all` | CSRF + access + role | Revoke all own sessions |
| GET | `/admin/auth/me` | Access + role | Return current admin and roles |
| PATCH | `/admin/auth/password` | CSRF + access + role | Change password and revoke all sessions |
