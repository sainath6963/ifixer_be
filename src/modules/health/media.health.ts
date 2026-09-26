import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { constants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { getErrorMessage } from '../../common/errors/error-message';

@Injectable()
export class MediaHealthIndicator {
  private readonly root: string;
  private readonly minimumFreeBytes: number;

  constructor(
    config: ConfigService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {
    const configuredRoot = config.getOrThrow<string>('MEDIA_STORAGE_ROOT');
    this.root = isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(process.cwd(), configuredRoot);
    this.minimumFreeBytes = config.getOrThrow<number>('MEDIA_MIN_FREE_BYTES');
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const storageStat = await stat(this.root);
      if (!storageStat.isDirectory()) {
        return indicator.down({ reason: 'Media storage root is not a directory' });
      }
      await access(this.root, constants.R_OK | constants.W_OK);
      const filesystem = await statfs(this.root);
      const freeBytes = filesystem.bavail * filesystem.bsize;
      if (freeBytes < this.minimumFreeBytes) {
        return indicator.down({
          reason: 'Media storage free space is below the configured safety floor',
          freeBytes,
          minimumFreeBytes: this.minimumFreeBytes,
        });
      }
      return indicator.up({
        provider: 'local',
        readable: true,
        writable: true,
        freeBytes,
        minimumFreeBytes: this.minimumFreeBytes,
      });
    } catch (error: unknown) {
      return indicator.down({ reason: getErrorMessage(error) });
    }
  }
}
