import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';

import { databaseMigrations } from './migrations';

interface MigrationRecord {
  _id: string;
  description: string;
  appliedAt: Date;
}

interface MigrationLock {
  _id: 'global';
  ownerId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

@Injectable()
export class MigrationRunner {
  private readonly logger = new Logger(MigrationRunner.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  async run(): Promise<void> {
    const database = this.connection.db;
    if (!database) {
      throw new Error('MongoDB connection is not initialized');
    }

    const hello = await database.admin().command({ hello: 1 });
    if (typeof hello.setName !== 'string') {
      throw new Error('Database migrations require MongoDB replica-set mode');
    }

    const ownerId = randomUUID();
    const locks = database.collection<MigrationLock>('database_migration_locks');
    const migrations = database.collection<MigrationRecord>('database_migrations');
    const now = new Date();

    await locks.deleteOne({ _id: 'global', expiresAt: { $lte: now } });

    try {
      await locks.insertOne({
        _id: 'global',
        ownerId,
        acquiredAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      });
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new Error('Another database migration process is already running');
      }
      throw error;
    }

    try {
      for (const migration of databaseMigrations) {
        const existing = await migrations.findOne({ _id: migration.id });
        if (existing) {
          this.logger.log(`Skipping applied migration ${migration.id}`);
          continue;
        }

        this.logger.log(`Applying migration ${migration.id}`);
        await migration.up({ connection: this.connection, database });
        await migrations.insertOne({
          _id: migration.id,
          description: migration.description,
          appliedAt: new Date(),
        });
        this.logger.log(`Applied migration ${migration.id}`);
      }
    } finally {
      await locks.deleteOne({ _id: 'global', ownerId });
    }
  }
}
