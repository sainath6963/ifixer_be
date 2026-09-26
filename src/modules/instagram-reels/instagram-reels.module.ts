import { Module } from '@nestjs/common';
import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import {
  AdminInstagramReelsController,
  InstagramReelsController,
} from './instagram-reels.controller';
import { InstagramReelsService } from './instagram-reels.service';
@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [InstagramReelsController, AdminInstagramReelsController],
  providers: [InstagramReelsService],
})
export class InstagramReelsModule {}
