import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { SeedModule } from '../database/seed/seed.module';
import { SeedService } from '../database/seed/seed.service';
import { getErrorMessage } from '../common/errors/error-message';

async function seed(): Promise<void> {
  const application = await NestFactory.createApplicationContext(SeedModule);

  try {
    await application.get(SeedService).run();
  } finally {
    await application.close();
  }
}

void seed().catch((error: unknown) => {
  process.stderr.write(`Database seed failed: ${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
