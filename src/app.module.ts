import { InstagramReelsModule } from './modules/instagram-reels/instagram-reels.module';
import { RepairJobModule } from './modules/repair-jobs/repair-job.module';
import { Module } from '@nestjs/common';
import { RepairCatalogModule } from './modules/repair-catalog/repair-catalog.module';
import { RepairBookingModule } from './modules/repair-bookings/repair-booking.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { validateEnvironment } from './config/environment';
import { CorePersistenceModule } from './database/core-persistence.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { RedisService } from './infrastructure/redis/redis.service';
import { RedisThrottlerStorage } from './infrastructure/redis/redis-throttler.storage';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AdminAnalyticsModule } from './modules/admin-analytics/admin-analytics.module';
import { AdminCatalogModule } from './modules/admin-catalog/admin-catalog.module';
import { AdminCustomersModule } from './modules/admin-customers/admin-customers.module';
import { AdminOrdersModule } from './modules/admin-orders/admin-orders.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { CustomerModule } from './modules/customer/customer.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationModule } from './modules/notifications/notification.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { PaymentModule } from './modules/payments/payment.module';
import { PromotionModule } from './modules/promotions/promotion.module';
import { ProductReviewModule } from './modules/product-reviews/product-review.module';
import { ReturnRequestModule } from './modules/returns/return-request.module';
import { StorefrontCatalogModule } from './modules/storefront-catalog/storefront-catalog.module';
import { SystemModule } from './modules/system/system.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      validate: validateEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const environment = config.getOrThrow<string>('NODE_ENV');
        const level = config.getOrThrow<string>('LOG_LEVEL');
        const release = config.getOrThrow<string>('APP_RELEASE');

        return {
          pinoHttp: {
            level,
            customProps: (): { service: string; release: string; environment: string } => ({
              service: 'rich-culture-api',
              release,
              environment,
            }),
            autoLogging: environment !== 'test',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers["x-repair-token"]',
                'req.headers.cookie',
                'res.headers.set-cookie',
                '*.password',
                '*.token',
                '*.secret',
              ],
              censor: '[REDACTED]',
            },
            transport:
              environment === 'development'
                ? {
                    target: 'pino-pretty',
                    options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
                  }
                : undefined,
            genReqId: (request, response): string => {
              const incomingId = request.headers['x-request-id'];
              const requestId =
                typeof incomingId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(incomingId)
                  ? incomingId
                  : randomUUID();
              response.setHeader('x-request-id', requestId);
              return requestId;
            },
          },
        };
      },
    }),
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService, redis: RedisService) => ({
        storage:
          config.getOrThrow<string>('RATE_LIMIT_STORAGE') === 'redis'
            ? new RedisThrottlerStorage(redis, config.getOrThrow<string>('RATE_LIMIT_KEY_PREFIX'))
            : undefined,
        throttlers: [
          {
            name: 'default',
            ttl: config.getOrThrow<number>('THROTTLE_TTL_MS'),
            limit: config.getOrThrow<number>('THROTTLE_LIMIT'),
          },
        ],
      }),
    }),
    DatabaseModule,
    CorePersistenceModule,
    RedisModule,
    QueueModule,
    AdminAuthModule,
    AdminAnalyticsModule,
    AdminCatalogModule,
    AdminCustomersModule,
    AdminOrdersModule,
    CustomerModule,
    CheckoutModule,
    PaymentModule,
    PromotionModule,
    ProductReviewModule,
    ReturnRequestModule,
    NotificationModule,
    StorefrontCatalogModule,
    HealthModule,
    SystemModule,
    WishlistModule,
    InstagramReelsModule,
    RepairCatalogModule,
    RepairBookingModule,
    RepairJobModule,
    ObservabilityModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
