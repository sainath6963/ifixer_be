# Production Acceptance and Security Gate

This runbook is the release gate for Phase 24. It covers production-only configuration validation, distributed rate limiting, public-information boundaries, browser security headers, read-only smoke checks, and deliberately bounded load tests. It does not replace a professional penetration test, Razorpay settlement checks, or business acceptance by the store owner.

## Mandatory production configuration

The API refuses to start in production unless these boundaries are explicit:

```dotenv
NODE_ENV=production
APP_RELEASE=2026.08.20-1
SWAGGER_ENABLED=false
TRUST_PROXY_HOPS=1
CORS_ORIGINS=https://store.example.com
COOKIE_SECURE=true
RATE_LIMIT_STORAGE=redis
RATE_LIMIT_KEY_PREFIX=rich-culture-production-rate-limit
```

- `CORS_ORIGINS` accepts a comma-separated list, but every production value must be an exact HTTPS origin with no path, credentials, query, fragment, or wildcard.
- `TRUST_PROXY_HOPS` must match the real trusted proxy chain. An incorrect value can make client-IP rate limiting unreliable; never increase it speculatively.
- `RATE_LIMIT_STORAGE=redis` makes counters consistent across API replicas and process restarts. Redis unavailability fails protected requests closed and also makes readiness fail, so alert on Redis before customers are affected.
- Use a production-specific `RATE_LIMIT_KEY_PREFIX` when multiple applications or environments share one Redis database.
- Swagger remains available in development/test only. Never relax this startup guard to debug production.

Production requirements from earlier phases—including HTTPS storefront URLs, secure cookies, SMTP, messaging-provider configuration, metrics authentication, absolute media storage, and non-placeholder secrets—still apply.

## Health information boundary

- `GET /api/v1/health/live` is a minimal, unthrottled process probe and returns no dependency details.
- `GET /api/v1/health/ready` performs all MongoDB, Redis, and media checks but returns only a sanitized status/timestamp. It is rate-limited.
- `GET /api/v1/admin/health/ready` returns detailed dependency state only to an authenticated `OWNER` or `STAFF` browser session.
- Detailed infrastructure automation should use protected metrics from the private monitoring network, not scrape admin cookies.

The public readiness route intentionally does not disclose replica-set names, media paths/capacity, Redis details, or individual dependency failures.

## HTTP and browser hardening

The API disables `X-Powered-By`, uses the simple query parser, defaults responses to `Cache-Control: no-store`, and applies API-oriented Helmet headers. Explicit public catalog/media cache headers override the safe default where content is designed to be shared.

Frontend Nginx applies:

- an enforced Content Security Policy with a narrow exception for Razorpay's hosted Checkout script;
- clickjacking protection through `frame-ancestors 'none'` and `X-Frame-Options: DENY`;
- HSTS, MIME-sniffing protection, referrer policy, permissions policy, and cross-origin opener/resource policies;
- immutable caching only for fingerprinted assets and `no-store` for the SPA entry document;
- GET/HEAD-only access for static routes and hidden Nginx version tokens.

The policy permits HTTPS frames because hosted payment flows can navigate through third-party payment and bank origins. Keep the broader frame exception isolated from `script-src`: arbitrary HTTPS scripts are not allowed. After any Razorpay Checkout update, verify the payment modal, UPI/card flows, failure handling, bank redirects, and browser console CSP reports in Test Mode before release.

HSTS is set without `includeSubDomains` or `preload`. Those options affect domains outside this application and require a separate domain-owner decision.

## Automated read-only smoke test

Run against staging after deployment:

```bash
cd backend
ACCEPTANCE_BASE_URL=https://staging.example.com \
ACCEPTANCE_EXPECT_RELEASE=2026.08.20-1 \
npm run ops:smoke
```

From the private monitoring network, optionally verify the authenticated metrics scrape:

```bash
ACCEPTANCE_BASE_URL=https://staging.example.com \
ACCEPTANCE_EXPECT_RELEASE=2026.08.20-1 \
ACCEPTANCE_METRICS_TOKEN='<secret>' \
npm run ops:smoke
```

The script performs GET/OPTIONS requests only. It validates API identity, security/cache headers, liveness, sanitized readiness, the admin-health boundary, metrics protection/release metadata, safe 404 responses, exact-origin credentialed CORS, frontend CSP, Razorpay script allowance, and HSTS. It never signs in, changes data, creates an order, calls Razorpay, or sends a notification.

For a direct local API check without frontend Nginx:

```bash
ACCEPTANCE_BASE_URL=http://127.0.0.1:4000 \
ACCEPTANCE_EXPECT_PRODUCTION=false \
ACCEPTANCE_CHECK_STOREFRONT=false \
ACCEPTANCE_CORS_ORIGIN=http://localhost:3000 \
npm run ops:smoke
```

## Controlled read-only load test

Start on staging with the lightweight health profile:

```bash
LOAD_TEST_BASE_URL=https://staging.example.com \
LOAD_TEST_CONFIRM=RUN_READ_ONLY_LOAD_TEST \
LOAD_TEST_PROFILE=health \
LOAD_TEST_DURATION_SECONDS=30 \
LOAD_TEST_REQUESTS_PER_SECOND=2 \
LOAD_TEST_CONCURRENCY=4 \
npm run ops:load:read-only
```

The storefront profile rotates only through fixed GET endpoints for API metadata, categories, products, and featured products:

```bash
LOAD_TEST_BASE_URL=https://staging.example.com \
LOAD_TEST_CONFIRM=RUN_READ_ONLY_LOAD_TEST \
LOAD_TEST_PROFILE=storefront \
LOAD_TEST_DURATION_SECONDS=60 \
LOAD_TEST_REQUESTS_PER_SECOND=2 \
LOAD_TEST_CONCURRENCY=4 \
LOAD_TEST_MAX_P95_MS=1000 \
LOAD_TEST_MAX_ERROR_PERCENT=1 \
npm run ops:load:read-only
```

Safety properties:

- non-local targets require HTTPS and the exact confirmation phrase;
- profiles and methods are hard-coded read-only—custom paths, cookies, tokens, request bodies, checkout, admin, and payment routes are not accepted;
- duration is capped at 300 seconds, request rate at 50 requests/second, and concurrency at 25;
- the command exits non-zero when the p95 or error threshold fails;
- responses larger than 2 MiB are treated as failures.

Run one profile at a time during a declared staging window. Watch API p95/5xx, CPU, memory, MongoDB latency/replication, Redis latency, queue backlog, and media disk. Stop immediately for sustained errors, resource saturation, replication lag, or customer impact. Do not point the command at production without explicit owner/operations authorization and a rollback-ready window.

This is a controlled baseline, not a capacity claim. Increase one variable at a time, record release/config/dataset/results, and set production capacity below the first observed saturation point with safety headroom.

## Manual release acceptance

Automation must be followed by a human Test Mode pass:

1. Verify desktop and mobile storefront navigation, catalog images, accessibility keyboard flow, account creation/sign-in/recovery, address/cart persistence, and admin access boundaries.
2. Complete one Razorpay Test Mode payment and confirm signature verification, signed webhook processing, paid order, stock commit, notifications, and idempotent duplicate webhook delivery.
3. Exercise abandoned/failed payment, pending-order expiry, refund, return/exchange, evidence privacy, shipment tracking, coupon allocation, and back-in-stock behavior.
4. Confirm no CSP, mixed-content, cookie, CORS, or network errors in supported browsers.
5. Verify authenticated admin health details, protected metrics, current backup checksums/off-site copy, and the latest isolated restore drill.
6. Record pass/fail evidence against the immutable `APP_RELEASE`; do not approve a different build using old evidence.

## Security review cadence

- Run both npm audits in CI and review high/critical findings before release; do not blindly apply breaking audit fixes.
- Review firewall rules, exposed ports, TLS certificate/expiry, OS patches, MongoDB/Redis authentication/network binding, secret age, admin accounts/sessions, and backup access before launch.
- Schedule authenticated authorization/business-logic testing and an external penetration test before high-value marketing traffic.
- Review CSP and payment-provider origins whenever checkout behavior or third-party scripts change.
- Rotate compromised credentials, revoke sessions, preserve audit logs, and follow the rollback/restore runbooks during an incident.

Phase 24 changes no MongoDB schema and requires no database migration.
