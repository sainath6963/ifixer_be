import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { Connection } from 'mongoose';

import { getErrorMessage } from '../../common/errors/error-message';

@Injectable()
export class MongoHealthIndicator {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const database = this.connection.db;
      if (!database) {
        return indicator.down({ reason: 'MongoDB connection is not initialized' });
      }

      await database.admin().command({ ping: 1, maxTimeMS: 2000 });
      const hello = await database.admin().command({ hello: 1 });
      const replicaSetName = typeof hello.setName === 'string' ? hello.setName : undefined;
      const requiresReplicaSet = this.config.getOrThrow<boolean>('MONGO_REQUIRE_REPLICA_SET');

      if (requiresReplicaSet && !replicaSetName) {
        return indicator.down({ reason: 'MongoDB is not running as a replica set' });
      }

      return indicator.up({
        replicaSet: replicaSetName ?? null,
        writablePrimary: hello.isWritablePrimary === true,
      });
    } catch (error: unknown) {
      return indicator.down({ reason: getErrorMessage(error) });
    }
  }
}
