import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const username = config.getOrThrow<string>('REDIS_USERNAME');
        const password = config.getOrThrow<string>('REDIS_PASSWORD');
        const useTls = config.getOrThrow<boolean>('REDIS_TLS');
        const connection: ConnectionOptions = {
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          username: username || undefined,
          password: password || undefined,
          db: config.getOrThrow<number>('REDIS_DB'),
          tls: useTls ? {} : undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
        };

        return {
          connection,
          prefix: config.getOrThrow<string>('QUEUE_PREFIX'),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
