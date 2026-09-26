import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';

import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_ACCESS_SECURITY,
  ADMIN_REFRESH_COOKIE,
  ADMIN_REFRESH_SECURITY,
} from './modules/admin-auth/auth.constants';
import {
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_ACCESS_SECURITY,
  CUSTOMER_REFRESH_COOKIE,
  CUSTOMER_REFRESH_SECURITY,
} from './modules/customer/customer.constants';

export function configureApplication(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  const apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
  const trustProxyHops = config.getOrThrow<number>('TRUST_PROXY_HOPS');
  const swaggerEnabled = config.getOrThrow<boolean>('SWAGGER_ENABLED');
  const environment = config.getOrThrow<string>('NODE_ENV');
  const allowedOrigins = config
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  app.use((request: Request, response: Response, next: NextFunction): void => {
    const incomingId = request.headers['x-request-id'];
    const requestId =
      typeof incomingId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(incomingId)
        ? incomingId
        : randomUUID();
    request.id = requestId;
    response.setHeader('x-request-id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity:
        environment === 'production'
          ? { maxAge: 31_536_000, includeSubDomains: false, preload: false }
          : false,
    }),
  );
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-CSRF-Token',
      'X-Repair-Token',
    ],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.setGlobalPrefix(apiPrefix);
  app.enableShutdownHooks();

  if (swaggerEnabled) {
    const documentConfig = new DocumentBuilder()
      .setTitle('Rich Culture API')
      .setDescription('Customer and admin API for the Rich Culture store')
      .setVersion('0.1.0')
      .addServer(`/${apiPrefix}`)
      .addCookieAuth(ADMIN_ACCESS_COOKIE, undefined, ADMIN_ACCESS_SECURITY)
      .addCookieAuth(ADMIN_REFRESH_COOKIE, undefined, ADMIN_REFRESH_SECURITY)
      .addCookieAuth(CUSTOMER_ACCESS_COOKIE, undefined, CUSTOMER_ACCESS_SECURITY)
      .addCookieAuth(CUSTOMER_REFRESH_COOKIE, undefined, CUSTOMER_REFRESH_SECURITY)
      .build();
    const document = SwaggerModule.createDocument(app, documentConfig, {
      ignoreGlobalPrefix: true,
    });
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs-json',
      swaggerOptions: { persistAuthorization: true },
    });
  }
}
