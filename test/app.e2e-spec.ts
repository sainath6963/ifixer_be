import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';

describe('Application foundation (e2e)', () => {
  let app: INestApplication;
  let httpServer: Server;

  beforeAll(async () => {
    process.env.RATE_LIMIT_STORAGE = 'redis';
    process.env.RATE_LIMIT_KEY_PREFIX = `rich-culture-app-e2e-${process.pid}`;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
  }, 30000);

  afterAll(async () => {
    await app.close();
    process.env.RATE_LIMIT_STORAGE = 'memory';
    process.env.RATE_LIMIT_KEY_PREFIX = 'rich-culture-test-rate-limit';
  });

  it('returns API metadata and a request ID', async () => {
    const response = await request(httpServer)
      .get('/api/v1')
      .set('x-request-id', 'e2e-request-1')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('e2e-request-1');
    const body = response.body as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'iFixer API',
      version: '0.1.0',
      environment: 'test',
    });
  });

  it('reports process liveness', async () => {
    const response = await request(httpServer).get('/api/v1/health/live').expect(200);
    const body = response.body as unknown as {
      status: string;
      uptimeSeconds: number;
    };

    expect(body.status).toBe('ok');
    expect(body.uptimeSeconds).toEqual(expect.any(Number));
  });

  it('reports sanitized readiness without exposing dependency details', async () => {
    const response = await request(httpServer).get('/api/v1/health/ready').expect(200);
    const body = response.body as unknown as {
      status: string;
      timestamp: string;
      details?: unknown;
      info?: unknown;
    };

    expect(body.status).toBe('ok');
    expect(body.timestamp).toEqual(expect.any(String));
    expect(body.details).toBeUndefined();
    expect(body.info).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    await request(httpServer).get('/api/v1/admin/health/ready').expect(401);
  });

  it('protects and exposes bounded Prometheus-compatible metrics', async () => {
    await request(httpServer).get('/api/v1/metrics').expect(401);
    const response = await request(httpServer)
      .get('/api/v1/metrics')
      .set('authorization', 'Bearer test-metrics-bearer-token-32-characters-minimum')
      .expect(200);

    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).toContain('# TYPE ifixer_build_info gauge');
    expect(response.text).toContain('release="test-suite"');
    expect(response.text).toContain('# TYPE ifixer_queue_jobs gauge');
    expect(response.text).toContain('# TYPE ifixer_notification_records gauge');
    expect(response.text).not.toContain('e2e-request-1');
  });

  it('publishes an OpenAPI document', async () => {
    const response = await request(httpServer).get('/docs-json').expect(200);
    const body = response.body as unknown as {
      info: { title: string };
      paths: Record<string, unknown>;
    };

    expect(body.info.title).toBe('iFixer API');
    expect(body.paths['/health/ready']).toBeDefined();
    expect(body.paths['/admin/health/ready']).toBeDefined();
    expect(body.paths['/metrics']).toBeUndefined();
  });

  it('enforces the readiness limit through Redis while liveness remains probe-safe', async () => {
    const live = await request(httpServer).get('/api/v1/health/live').expect(200);
    expect(live.headers['x-ratelimit-limit']).toBeUndefined();

    for (let attempt = 0; attempt < 29; attempt += 1) {
      await request(httpServer).get('/api/v1/health/ready').expect(200);
    }
    const blocked = await request(httpServer).get('/api/v1/health/ready').expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
