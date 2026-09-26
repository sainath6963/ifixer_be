import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Connection, Model } from 'mongoose';

import { MediaAsset } from '../schemas/catalog.schema';
import { ReturnEvidence } from '../schemas/return-evidence.schema';
import { ReturnRequest } from '../schemas/return-request.schema';
import { MediaStatus, ReturnEvidenceStatus } from '../../domain/enums';

export interface MediaReconciliationResult {
  staleStagingDirectoriesRemoved: number;
  stalePendingAssetsRemoved: number;
  deletedAssetDirectoriesRemoved: number;
  readyAssetsMissingFiles: number;
  staleReturnEvidenceStagingDirectoriesRemoved: number;
  stalePendingReturnEvidenceRemoved: number;
  deletedReturnEvidenceFilesRemoved: number;
  readyReturnEvidenceMissingFiles: number;
}

@Injectable()
export class MediaMaintenanceService {
  private readonly logger = new Logger(MediaMaintenanceService.name);
  private readonly root: string;
  private readonly stagingMaxAgeSeconds: number;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MediaAsset.name) private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(ReturnEvidence.name) private readonly returnEvidence: Model<ReturnEvidence>,
    @InjectModel(ReturnRequest.name) private readonly returnRequests: Model<ReturnRequest>,
    config: ConfigService,
  ) {
    const configuredRoot = config.getOrThrow<string>('MEDIA_STORAGE_ROOT');
    this.root = isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(process.cwd(), configuredRoot);
    this.stagingMaxAgeSeconds = config.getOrThrow<number>('MEDIA_STAGING_MAX_AGE_SECONDS');
  }

  async run(): Promise<MediaReconciliationResult> {
    const cutoff = new Date(Date.now() - this.stagingMaxAgeSeconds * 1000);
    const result: MediaReconciliationResult = {
      staleStagingDirectoriesRemoved: await this.removeStaleStagingDirectories(cutoff),
      stalePendingAssetsRemoved: 0,
      deletedAssetDirectoriesRemoved: 0,
      readyAssetsMissingFiles: 0,
      staleReturnEvidenceStagingDirectoriesRemoved:
        await this.removeStaleReturnEvidenceStagingDirectories(cutoff),
      stalePendingReturnEvidenceRemoved: 0,
      deletedReturnEvidenceFilesRemoved: 0,
      readyReturnEvidenceMissingFiles: 0,
    };

    const stalePending = await this.mediaAssets
      .find({ status: MediaStatus.Pending, createdAt: { $lt: cutoff } })
      .exec();
    for (const asset of stalePending) {
      await rm(dirname(this.safePath(asset.storageKey)), { recursive: true, force: true });
      const removed = await this.mediaAssets.deleteOne({
        _id: asset._id,
        status: MediaStatus.Pending,
        createdAt: { $lt: cutoff },
      });
      result.stalePendingAssetsRemoved += removed.deletedCount;
    }

    const deleted = await this.mediaAssets.find({ status: MediaStatus.Deleted }).exec();
    for (const asset of deleted) {
      const directory = dirname(this.safePath(asset.storageKey));
      try {
        const directoryStat = await stat(directory);
        if (directoryStat.isDirectory()) {
          await rm(directory, { recursive: true, force: true });
          result.deletedAssetDirectoriesRemoved += 1;
        }
      } catch {
        // Already absent is the desired state.
      }
    }

    const ready = await this.mediaAssets.find({ status: MediaStatus.Ready }).exec();
    for (const asset of ready) {
      const keys = [asset.storageKey, ...asset.variants.map((variant) => variant.storageKey)];
      for (const key of keys) {
        try {
          const fileStat = await stat(this.safePath(key));
          if (!fileStat.isFile()) result.readyAssetsMissingFiles += 1;
        } catch {
          result.readyAssetsMissingFiles += 1;
        }
      }
    }

    const staleEvidence = await this.returnEvidence
      .find({ status: ReturnEvidenceStatus.Pending, createdAt: { $lt: cutoff } })
      .exec();
    for (const item of staleEvidence) {
      await rm(this.safePath(item.storageKey), { force: true });
      await this.connection.transaction(async (session): Promise<void> => {
        const removed = await this.returnEvidence.deleteOne(
          {
            _id: item._id,
            status: ReturnEvidenceStatus.Pending,
            createdAt: { $lt: cutoff },
          },
          { session },
        );
        if (!removed.deletedCount) return;
        await this.returnRequests.updateOne(
          { _id: item.returnRequestId, evidenceCount: { $gt: 0 } },
          { $inc: { evidenceCount: -1, version: 1 } },
          { session },
        );
        result.stalePendingReturnEvidenceRemoved += 1;
      });
    }

    const deletedEvidence = await this.returnEvidence
      .find({ status: ReturnEvidenceStatus.Deleted })
      .exec();
    for (const item of deletedEvidence) {
      const filePath = this.safePath(item.storageKey);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isFile()) {
          await rm(filePath, { force: true });
          result.deletedReturnEvidenceFilesRemoved += 1;
        }
      } catch {
        // Already absent is the desired state.
      }
    }

    const readyEvidence = await this.returnEvidence
      .find({ status: ReturnEvidenceStatus.Ready })
      .exec();
    for (const item of readyEvidence) {
      try {
        const fileStat = await stat(this.safePath(item.storageKey));
        if (!fileStat.isFile()) result.readyReturnEvidenceMissingFiles += 1;
      } catch {
        result.readyReturnEvidenceMissingFiles += 1;
      }
    }

    this.logger.log(`Media reconciliation complete: ${JSON.stringify(result)}`);
    return result;
  }

  private async removeStaleStagingDirectories(cutoff: Date): Promise<number> {
    const stagingRoot = this.safePath('.staging');
    let entries;
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'return-evidence') continue;
      const path = this.safePath(`.staging/${entry.name}`);
      const directoryStat = await stat(path);
      if (directoryStat.mtime < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async removeStaleReturnEvidenceStagingDirectories(cutoff: Date): Promise<number> {
    const stagingRoot = this.safePath('.staging/return-evidence');
    let entries;
    try {
      entries = await readdir(stagingRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = this.safePath(`.staging/return-evidence/${entry.name}`);
      const directoryStat = await stat(path);
      if (directoryStat.mtime < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private safePath(storageKey: string): string {
    const path = resolve(this.root, storageKey);
    const pathRelativeToRoot = relative(this.root, path);
    if (
      pathRelativeToRoot === '' ||
      pathRelativeToRoot.startsWith(`..${sep}`) ||
      pathRelativeToRoot === '..' ||
      isAbsolute(pathRelativeToRoot)
    ) {
      throw new Error('Unsafe media storage path');
    }
    return path;
  }
}
