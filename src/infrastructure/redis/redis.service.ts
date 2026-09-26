import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;

  constructor(config: ConfigService) {
    const username = config.getOrThrow<string>('REDIS_USERNAME');
    const password = config.getOrThrow<string>('REDIS_PASSWORD');
    const useTls = config.getOrThrow<boolean>('REDIS_TLS');

    this.client = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      username: username || undefined,
      password: password || undefined,
      db: config.getOrThrow<number>('REDIS_DB'),
      tls: useTls ? {} : undefined,
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 3000,
    });
  }

  async ping(): Promise<string> {
    await this.ensureConnected();
    return this.client.ping();
  }

  async evaluateScript(script: string, keys: string[], arguments_: string[]): Promise<unknown> {
    await this.ensureConnected();
    return this.client.eval(script, keys.length, ...keys, ...arguments_);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'ready') {
      await this.client.quit();
      return;
    }

    this.client.disconnect(false);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'wait') {
      await this.client.connect();
    }
  }
}
