#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const profiles = {
  health: ['/api/v1/health/live'],
  storefront: [
    '/api/v1',
    '/api/v1/catalog/categories',
    '/api/v1/catalog/products?limit=12',
    '/api/v1/catalog/products/featured?limit=4',
  ],
};

const target = requiredOrigin('LOAD_TEST_BASE_URL');
const profileName = process.env.LOAD_TEST_PROFILE?.trim() || 'health';
const paths = profiles[profileName];
if (!paths) throw new Error('LOAD_TEST_PROFILE must be health or storefront');

const localTarget = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
if (!localTarget && target.protocol !== 'https:') {
  throw new Error('Non-local load tests require HTTPS');
}
if (!localTarget && process.env.LOAD_TEST_CONFIRM !== 'RUN_READ_ONLY_LOAD_TEST') {
  throw new Error('Set LOAD_TEST_CONFIRM=RUN_READ_ONLY_LOAD_TEST for a non-local target');
}

const durationSeconds = boundedNumber('LOAD_TEST_DURATION_SECONDS', 15, 5, 300);
const requestsPerSecond = boundedNumber('LOAD_TEST_REQUESTS_PER_SECOND', 2, 1, 50);
const concurrency = boundedInteger('LOAD_TEST_CONCURRENCY', 4, 1, 25);
const timeoutMs = boundedNumber('LOAD_TEST_TIMEOUT_MS', 5_000, 500, 30_000);
const maxP95Ms = boundedNumber('LOAD_TEST_MAX_P95_MS', 1_000, 1, 60_000);
const maxErrorPercent = boundedNumber('LOAD_TEST_MAX_ERROR_PERCENT', 1, 0, 100);
const startedAt = performance.now();
const endsAt = startedAt + durationSeconds * 1000;
const intervalMs = 1000 / requestsPerSecond;
const latencies = [];
const statuses = new Map();
const errors = new Map();
let sequence = 0;

async function worker() {
  while (true) {
    const current = sequence;
    sequence += 1;
    const scheduledAt = startedAt + current * intervalMs;
    if (scheduledAt >= endsAt) return;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 0) await delay(waitMs);
    const path = paths[current % paths.length];
    const requestStarted = performance.now();
    try {
      const response = await fetch(new URL(path, target), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'RichCulture-ReadOnly-Load-Test/1.0',
        },
      });
      const body = await response.arrayBuffer();
      if (body.byteLength > 2_097_152) throw new Error('response_too_large');
      statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      if (response.status < 200 || response.status >= 300) {
        errors.set(`http_${response.status}`, (errors.get(`http_${response.status}`) || 0) + 1);
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown_error';
      errors.set(name, (errors.get(name) || 0) + 1);
    } finally {
      latencies.push(performance.now() - requestStarted);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

latencies.sort((left, right) => left - right);
const total = latencies.length;
const errorCount = [...errors.values()].reduce((sum, count) => sum + count, 0);
const errorPercent = total ? (errorCount / total) * 100 : 100;
const result = {
  target: target.origin,
  profile: profileName,
  readOnly: true,
  configured: { durationSeconds, requestsPerSecond, concurrency, timeoutMs },
  observed: {
    requests: total,
    requestsPerSecond: round(total / ((performance.now() - startedAt) / 1000)),
    errorPercent: round(errorPercent),
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies.at(-1) || 0),
    },
    statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right)),
    errors: Object.fromEntries([...errors.entries()].sort()),
  },
  thresholds: { maxP95Ms, maxErrorPercent },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!total || result.observed.latencyMs.p95 > maxP95Ms || errorPercent > maxErrorPercent) {
  process.exitCode = 1;
}

function requiredOrigin(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  return url;
}

function boundedNumber(name, fallback, minimum, maximum) {
  const value = process.env[name]?.trim() || String(fallback);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${name} must be numeric`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
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

function percentile(values, percentage) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.ceil((percentage / 100) * values.length) - 1)];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
