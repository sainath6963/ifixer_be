import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { MigrationModule } from '../database/migrations/migration.module';
import { MigrationRunner } from '../database/migrations/migration-runner.service';
import { getErrorMessage } from '../common/errors/error-message';

async function migrate(): Promise<void> {
  const application = await NestFactory.createApplicationContext(MigrationModule);

  try {
    await application.get(MigrationRunner).run();
  } finally {
    await application.close();
  }
}

void migrate().catch((error: unknown) => {
  process.stderr.write(`Database migration failed: ${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
