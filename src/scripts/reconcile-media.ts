import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { getErrorMessage } from '../common/errors/error-message';
import { MediaMaintenanceModule } from '../database/media-maintenance/media-maintenance.module';
import { MediaMaintenanceService } from '../database/media-maintenance/media-maintenance.service';

async function reconcileMedia(): Promise<void> {
  const application = await NestFactory.createApplicationContext(MediaMaintenanceModule);
  try {
    await application.get(MediaMaintenanceService).run();
  } finally {
    await application.close();
  }
}

void reconcileMedia().catch((error: unknown) => {
  process.stderr.write(`Media reconciliation failed: ${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
