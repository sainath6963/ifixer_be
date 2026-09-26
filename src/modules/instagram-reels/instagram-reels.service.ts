import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, HydratedDocument, Model, Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { InstagramReel } from '../../database/schemas/instagram-reel.schema';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { SaveInstagramReelDto } from './instagram-reels.dto';

export function canonicalReelUrl(value: string): string {
  const message =
    'Paste an HTTPS Instagram Reel link such as https://www.instagram.com/reel/ABC123/. Open shared redirects in Instagram first and copy the Reel link.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException(message);
  }
  const match = /^\/reels?\/([A-Za-z0-9_-]{5,64})\/?$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    !['instagram.com', 'www.instagram.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !match
  )
    throw new BadRequestException(message);
  return `https://www.instagram.com/reel/${match[1]}/`;
}
export interface ReelView {
  id: string;
  url: string;
  title: string;
  sortOrder: number;
  active?: boolean;
  version?: number;
}
export interface ReelsPage {
  items: ReelView[];
  page: number;
  total: number;
  totalPages: number;
}
@Injectable()
export class InstagramReelsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(InstagramReel.name) private readonly reels: Model<InstagramReel>,
    private readonly audit: AuthAuditService,
  ) {}
  async list(page: number, admin = false, requestedLimit?: number): Promise<ReelsPage> {
    const filter = admin ? {} : { active: true };
    const limit = requestedLimit ?? (admin ? 20 : 6);
    const [rows, total] = await Promise.all([
      this.reels
        .find(filter)
        .sort({ sortOrder: 1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.reels.countDocuments(filter),
    ]);
    return {
      items: rows.map((row) => this.view(row, admin)),
      page,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }
  async save(
    input: SaveInstagramReelDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
    id?: string,
  ): Promise<ReelView> {
    const fields = {
      url: canonicalReelUrl(input.url),
      title: input.title,
      active: input.active,
      sortOrder: input.sortOrder,
    };
    if (id && (!Types.ObjectId.isValid(id) || !/^[a-fA-F0-9]{24}$/.test(id)))
      throw new NotFoundException('Reel not found');
    if (id && input.expectedVersion === undefined)
      throw new BadRequestException('The current version is required when editing a Reel');
    try {
      return await this.connection.transaction(async (session) => {
        let row: HydratedDocument<InstagramReel>;
        if (id) {
          const existing = await this.reels.findById(id).session(session);
          if (!existing) throw new NotFoundException('Reel not found');
          if (existing.get('version') !== input.expectedVersion)
            throw new ConflictException(
              'This Reel changed. Refresh the list and reopen it before saving.',
            );
          row = existing;
          Object.assign(row, fields);
        } else row = new this.reels(fields);
        await row.save({ session });
        await this.audit.record(
          {
            action: id ? 'INSTAGRAM_REEL_UPDATED' : 'INSTAGRAM_REEL_CREATED',
            resourceType: 'INSTAGRAM_REEL',
            resourceId: row.id,
            actorId: admin.id,
            context,
          },
          session,
        );
        return this.view(row, true);
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictException(
          'This Reel is already saved. Edit its existing entry to show, hide or reorder it.',
        );
      throw error;
    }
  }
  private view(row: HydratedDocument<InstagramReel>, admin: boolean): ReelView {
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      sortOrder: row.sortOrder,
      ...(admin ? { active: row.active, version: row.get('version') as number } : {}),
    };
  }
}
