import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { getErrorMessage } from '../common/errors/error-message';
import { AdminBootstrapModule } from '../database/admin-bootstrap/admin-bootstrap.module';
import { AdminBootstrapService } from '../database/admin-bootstrap/admin-bootstrap.service';

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function bootstrapAdmin(): Promise<void> {
  const application = await NestFactory.createApplicationContext(AdminBootstrapModule);

  try {
    await application.get(AdminBootstrapService).run({
      name: requireEnvironment('BOOTSTRAP_ADMIN_NAME'),
      email: requireEnvironment('BOOTSTRAP_ADMIN_EMAIL'),
      password: requireEnvironment('BOOTSTRAP_ADMIN_PASSWORD'),
    });
  } finally {
    await application.close();
  }
}

void bootstrapAdmin().catch((error: unknown) => {
  process.stderr.write(`Admin bootstrap failed: ${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
