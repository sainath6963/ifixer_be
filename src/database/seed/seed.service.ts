import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { StoreSetting } from '../schemas/operations.schema';

interface SeedSetting {
  key: string;
  value: unknown;
  isPublic: boolean;
  description: string;
}

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectModel(StoreSetting.name) private readonly settings: Model<StoreSetting>,
  ) {}

  async run(): Promise<void> {
    if (this.config.getOrThrow<string>('NODE_ENV') === 'production') {
      throw new Error('Development seed is disabled in production');
    }

    const defaultSettings: SeedSetting[] = [
      {
        key: 'store.currency',
        value: 'INR',
        isPublic: true,
        description: 'Store settlement and display currency',
      },
      {
        key: 'checkout.inventoryReservationMinutes',
        value: 15,
        isPublic: false,
        description: 'Pending checkout inventory reservation lifetime',
      },
      {
        key: 'media.storageProvider',
        value: 'LOCAL',
        isPublic: false,
        description: 'Active product media storage provider',
      },
      {
        key: 'store.timezone',
        value: 'Asia/Kolkata',
        isPublic: true,
        description: 'Business timezone',
      },
    ];

    const result = await this.settings.bulkWrite(
      defaultSettings.map((setting) => ({
        updateOne: {
          filter: { key: setting.key },
          update: { $setOnInsert: setting },
          upsert: true,
        },
      })),
      { ordered: true },
    );

    this.logger.log(
      `Seed complete: ${result.upsertedCount} settings inserted, ${result.matchedCount} retained`,
    );
  }
}
