#!/usr/bin/env node

const baseUrl = requiredUrl('ACCEPTANCE_BASE_URL');
const apiPrefix = normalizedPrefix(process.env.ACCEPTANCE_API_PREFIX || 'api/v1');
const expectProduction = process.env.ACCEPTANCE_EXPECT_PRODUCTION !== 'false';
const checkStorefront = process.env.ACCEPTANCE_CHECK_STOREFRONT !== 'false';
const metricsToken = process.env.ACCEPTANCE_METRICS_TOKEN?.trim() || '';
const expectedRelease = process.env.ACCEPTANCE_EXPECT_RELEASE?.trim() || '';
const expectedApiName = process.env.ACCEPTANCE_API_NAME?.trim() || 'iFixer API';
const metricsPrefix = process.env.ACCEPTANCE_METRICS_PREFIX?.trim() || 'ifixer';
const corsOrigin =
  process.env.ACCEPTANCE_CORS_ORIGIN?.trim() || (checkStorefront ? baseUrl.origin : '');
const timeoutMs = boundedInteger('ACCEPTANCE_TIMEOUT_MS', 10_000, 1_000, 30_000);
const passed = [];

if (expectProduction && baseUrl.protocol !== 'https:') {
  throw new Error('Production acceptance requires an HTTPS base URL');
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  });
  return response;
}

function pass(label) {
  passed.push(label);
  process.stdout.write(`PASS ${label}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertHeader(response, name, expected) {
  const actual = response.headers.get(name) || '';
  assert(expected.test(actual), `${name} header failed: ${actual || '<missing>'}`);
}

async function json(response, label) {
  const contentType = response.headers.get('content-type') || '';
  assert(contentType.includes('application/json'), `${label} did not return JSON`);
  return response.json();
}

const metadata = await request(`/${apiPrefix}`);
assert(metadata.status === 200, `API metadata returned HTTP ${metadata.status}`);
assertHeader(metadata, 'x-content-type-options', /^nosniff$/i);
assertHeader(metadata, 'cross-origin-resource-policy', /^same-site$/i);
assertHeader(metadata, 'referrer-policy', /^no-referrer$/i);
assertHeader(metadata, 'cache-control', /no-store/i);
assert(!metadata.headers.has('x-powered-by'), 'API exposes X-Powered-By');
const metadataBody = await json(metadata, 'API metadata');
assert(metadataBody.name === expectedApiName, 'Unexpected API identity');
pass('API identity and security headers');

const live = await request(`/${apiPrefix}/health/live`);
assert(live.status === 200, `Liveness returned HTTP ${live.status}`);
const liveBody = await json(live, 'Liveness');
assert(liveBody.status === 'ok', 'Liveness is not ok');
pass('process liveness');

const ready = await request(`/${apiPrefix}/health/ready`);
assert(ready.status === 200, `Readiness returned HTTP ${ready.status}`);
const readinessText = await ready.text();
const readinessBody = JSON.parse(readinessText);
assert(readinessBody.status === 'ok', 'Readiness is not ok');
assert(
  !/(mongodb|redis|mediaStorage|replicaSet|freeBytes)/i.test(readinessText),
  'Public readiness leaks dependency details',
);
pass('sanitized dependency readiness');

const adminHealth = await request(`/${apiPrefix}/admin/health/ready`);
assert(adminHealth.status === 401, `Admin health boundary returned HTTP ${adminHealth.status}`);
pass('admin health authentication boundary');

const metrics = await request(`/${apiPrefix}/metrics`, {
  headers: metricsToken ? { Authorization: `Bearer ${metricsToken}` } : undefined,
});
if (metricsToken) {
  assert(metrics.status === 200, `Authenticated metrics returned HTTP ${metrics.status}`);
  const body = await metrics.text();
  assert(
    body.includes(`# TYPE ${metricsPrefix}_build_info gauge`),
    'Metrics build info is missing',
  );
  if (expectedRelease) {
    assert(body.includes(`release="${expectedRelease}"`), 'Metrics release does not match');
  }
  pass('authenticated metrics scrape');
} else {
  assert(
    [401, 403, 404].includes(metrics.status),
    `Public metrics boundary returned HTTP ${metrics.status}`,
  );
  pass('public metrics boundary');
}

const missing = await request(`/${apiPrefix}/phase24-route-that-does-not-exist`);
assert(missing.status === 404, `Unknown API route returned HTTP ${missing.status}`);
const missingText = await missing.text();
assert(!/node_modules|\.ts:\d+|Error:\s/i.test(missingText), 'Error response exposes a stack');
pass('safe API error response');

if (corsOrigin) {
  const cors = await request(`/${apiPrefix}`, {
    method: 'OPTIONS',
    headers: {
      Origin: corsOrigin,
      'Access-Control-Request-Method': 'GET',
    },
  });
  assert([200, 204].includes(cors.status), `CORS preflight returned HTTP ${cors.status}`);
  assert(
    cors.headers.get('access-control-allow-origin') === corsOrigin,
    'CORS did not return the exact expected origin',
  );
  assert(
    cors.headers.get('access-control-allow-credentials') === 'true',
    'Credentialed CORS is not enabled',
  );
  pass('exact-origin credentialed CORS');
}

if (checkStorefront) {
  const storefront = await request('/');
  assert(storefront.status === 200, `Storefront returned HTTP ${storefront.status}`);
  assertHeader(storefront, 'content-type', /text\/html/i);
  assertHeader(storefront, 'x-frame-options', /^deny$/i);
  assertHeader(storefront, 'x-content-type-options', /^nosniff$/i);
  assertHeader(storefront, 'cross-origin-opener-policy', /^same-origin-allow-popups$/i);
  assertHeader(storefront, 'permissions-policy', /camera=\(\).*geolocation=\(\).*microphone=\(\)/i);
  const csp = storefront.headers.get('content-security-policy') || '';
  assert(csp.includes("default-src 'self'"), 'Storefront CSP default source is missing');
  assert(csp.includes("frame-ancestors 'none'"), 'Storefront CSP frame boundary is missing');
  assert(csp.includes('checkout.razorpay.com'), 'Storefront CSP blocks Razorpay Checkout');
  if (expectProduction) {
    assertHeader(storefront, 'strict-transport-security', /max-age=\d+/i);
  }
  pass('storefront security policy');
}

process.stdout.write(
  `Production acceptance passed ${passed.length} checks for ${baseUrl.origin}.\n`,
);

function requiredUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  return url;
}

function normalizedPrefix(value) {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(normalized)) {
    throw new Error('ACCEPTANCE_API_PREFIX is invalid');
  }
  return normalized;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = process.env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
