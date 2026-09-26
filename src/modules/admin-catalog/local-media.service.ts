import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Connection, Model, Types } from 'mongoose';
import sharp from 'sharp';

import {
  Category,
  MediaAsset,
  MediaAssetDocument,
  Product,
} from '../../database/schemas/catalog.schema';
import { MediaStatus, StorageProvider } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { MediaAssetView, PageResult } from './catalog.types';
import type { MediaListQueryDto } from './dto/media.dto';

const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
const OUTPUT_VARIANTS = [
  { name: 'thumbnail', width: 320, height: 320 },
  { name: 'card', width: 800, height: 1000 },
  { name: 'large', width: 1600, height: 2000 },
] as const;

export type MediaDeliveryVariant = 'original' | 'thumbnail' | 'card' | 'large';

export interface MediaDelivery {
  stream: ReturnType<typeof createReadStream>;
  sizeBytes: number;
  mimeType: string;
}

@Injectable()
export class LocalMediaService implements OnModuleInit {
  private readonly root: string;
  private readonly maxUploadBytes: number;
  private readonly maxInputPixels: number;
  private readonly quality: number;
  private readonly mediaUrlPrefix: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MediaAsset.name) private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Category.name) private readonly categories: Model<Category>,
    private readonly audit: AuthAuditService,
    config: ConfigService,
  ) {
    const configuredRoot = config.getOrThrow<string>('MEDIA_STORAGE_ROOT');
    this.root = isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(process.cwd(), configuredRoot);
    this.maxUploadBytes = config.getOrThrow<number>('MEDIA_MAX_UPLOAD_BYTES');
    this.maxInputPixels = config.getOrThrow<number>('MEDIA_MAX_INPUT_PIXELS');
    this.quality = config.getOrThrow<number>('MEDIA_WEBP_QUALITY');
    const apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
    this.mediaUrlPrefix = `/${apiPrefix}/media`;
  }

  async onModuleInit(): Promise<void> {
    await mkdir(resolve(this.root, '.staging'), { recursive: true, mode: 0o750 });
    await mkdir(resolve(this.root, 'assets'), { recursive: true, mode: 0o750 });
  }

  async uploadImage(
    file: Express.Multer.File | undefined,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<MediaAssetView> {
    if (!file?.buffer?.length) {
      throw new BadRequestException({
        code: 'IMAGE_FILE_REQUIRED',
        message: 'Image file is required',
      });
    }
    if (file.size > this.maxUploadBytes) {
      throw new BadRequestException({
        code: 'IMAGE_TOO_LARGE',
        message: `Image exceeds the ${this.maxUploadBytes}-byte upload limit`,
      });
    }

    const assetId = new Types.ObjectId();
    const relativeDirectory = `assets/${assetId.toHexString().slice(0, 2)}/${assetId.toHexString()}`;
    const finalDirectory = this.safePath(relativeDirectory);
    const stagingDirectory = this.safePath(`.staging/${randomUUID()}`);
    await mkdir(stagingDirectory, { recursive: false, mode: 0o750 });
    let processingFinished = false;

    try {
      const image = sharp(file.buffer, {
        failOn: 'warning',
        limitInputPixels: this.maxInputPixels,
        pages: 1,
      });
      const metadata = await image.metadata();
      if (
        !metadata.format ||
        !ALLOWED_INPUT_FORMATS.has(metadata.format) ||
        !metadata.width ||
        !metadata.height ||
        (metadata.pages ?? 1) !== 1
      ) {
        throw new BadRequestException({
          code: 'IMAGE_FORMAT_INVALID',
          message: 'Only single-frame JPEG, PNG, WebP, and AVIF images are supported',
        });
      }

      const originalStorageKey = `${relativeDirectory}/original.webp`;
      const originalOutput = await this.writeVariant(
        file.buffer,
        resolve(stagingDirectory, 'original.webp'),
        2400,
        2400,
      );
      const variants = [];
      for (const variant of OUTPUT_VARIANTS) {
        const storageKey = `${relativeDirectory}/${variant.name}.webp`;
        const output = await this.writeVariant(
          file.buffer,
          resolve(stagingDirectory, `${variant.name}.webp`),
          variant.width,
          variant.height,
        );
        variants.push({ name: variant.name, storageKey, ...output });
      }
      const checksumSha256 = createHash('sha256')
        .update(await readFile(resolve(stagingDirectory, 'original.webp')))
        .digest('hex');
      const safeOriginalFilename = this.sanitizeFilename(file.originalname);
      processingFinished = true;

      const pending = await this.mediaAssets.create({
        _id: assetId,
        storageProvider: StorageProvider.Local,
        storageKey: originalStorageKey,
        originalFilename: safeOriginalFilename,
        mimeType: 'image/webp',
        sizeBytes: originalOutput.sizeBytes,
        checksumSha256,
        width: originalOutput.width,
        height: originalOutput.height,
        status: MediaStatus.Pending,
        variants,
        createdBy: new Types.ObjectId(admin.id),
      });

      try {
        await mkdir(dirname(finalDirectory), { recursive: true, mode: 0o750 });
        await rename(stagingDirectory, finalDirectory);
      } catch (error: unknown) {
        await this.mediaAssets.deleteOne({ _id: assetId, status: MediaStatus.Pending });
        throw error;
      }

      const ready = await this.connection.transaction(
        async (session): Promise<MediaAssetDocument> => {
          const updated = await this.mediaAssets
            .findOneAndUpdate(
              { _id: pending._id, status: MediaStatus.Pending },
              { $set: { status: MediaStatus.Ready } },
              { session, returnDocument: 'after' },
            )
            .exec();
          if (!updated) {
            throw new ConflictException({
              code: 'MEDIA_STATE_CONFLICT',
              message: 'Media state changed while completing upload',
            });
          }
          await this.audit.record(
            {
              action: 'MEDIA_IMAGE_UPLOADED',
              resourceType: 'MEDIA_ASSET',
              resourceId: updated.id,
              actorId: admin.id,
              context,
              metadata: { width: updated.width, height: updated.height },
            },
            session,
          );
          return updated;
        },
      );
      return this.toView(ready);
    } catch (error: unknown) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      if (processingFinished) {
        throw new InternalServerErrorException({
          code: 'MEDIA_STORAGE_FAILED',
          message: 'Image processing completed but local storage could not be committed',
        });
      }
      throw new BadRequestException({
        code: 'IMAGE_PROCESSING_FAILED',
        message: 'Image could not be safely decoded and processed',
      });
    }
  }

  async list(query: MediaListQueryDto): Promise<PageResult<MediaAssetView>> {
    const filter = query.status ? { status: query.status } : {};
    const skip = (query.page - 1) * query.limit;
    const [documents, total] = await Promise.all([
      this.mediaAssets.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(query.limit),
      this.mediaAssets.countDocuments(filter),
    ]);
    return {
      items: documents.map((document) => this.toView(document)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async delivery(assetId: string, variantName: MediaDeliveryVariant): Promise<MediaDelivery> {
    this.assertObjectId(assetId);
    const asset = await this.mediaAssets
      .findOne({ _id: assetId, status: MediaStatus.Ready })
      .exec();
    if (!asset) {
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Media asset was not found',
      });
    }

    const selected =
      variantName === 'original'
        ? { storageKey: asset.storageKey, sizeBytes: asset.sizeBytes }
        : asset.variants.find((variant) => variant.name === variantName);
    if (!selected) {
      throw new NotFoundException({
        code: 'MEDIA_VARIANT_NOT_FOUND',
        message: 'Media variant was not found',
      });
    }
    const path = this.safePath(selected.storageKey);
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        throw new Error('Not a file');
      }
      return { stream: createReadStream(path), sizeBytes: fileStat.size, mimeType: asset.mimeType };
    } catch {
      throw new NotFoundException({
        code: 'MEDIA_FILE_MISSING',
        message: 'Media file is unavailable',
      });
    }
  }

  async delete(
    assetId: string,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<void> {
    this.assertObjectId(assetId);
    const objectId = new Types.ObjectId(assetId);
    const deleted = await this.connection.transaction(
      async (session): Promise<MediaAssetDocument> => {
        const productReference = await this.products
          .exists({ 'images.mediaAssetId': objectId })
          .session(session);
        const categoryReference = await this.categories
          .exists({ imageMediaId: objectId })
          .session(session);
        if (productReference || categoryReference) {
          throw new ConflictException({
            code: 'MEDIA_IN_USE',
            message: 'Detach this image from products and categories before deleting it',
          });
        }
        const updated = await this.mediaAssets
          .findOneAndUpdate(
            { _id: objectId, status: { $ne: MediaStatus.Deleted } },
            { $set: { status: MediaStatus.Deleted, deletedAt: new Date() } },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!updated) {
          throw new NotFoundException({
            code: 'MEDIA_NOT_FOUND',
            message: 'Media asset was not found',
          });
        }
        await this.audit.record(
          {
            action: 'MEDIA_IMAGE_DELETED',
            resourceType: 'MEDIA_ASSET',
            resourceId: updated.id,
            actorId: admin.id,
            context,
          },
          session,
        );
        return updated;
      },
    );
    await rm(dirname(this.safePath(deleted.storageKey)), { recursive: true, force: true });
  }

  private async writeVariant(
    input: Buffer,
    outputPath: string,
    width: number,
    height: number,
  ): Promise<{ width: number; height: number; sizeBytes: number }> {
    const info = await sharp(input, {
      failOn: 'warning',
      limitInputPixels: this.maxInputPixels,
      pages: 1,
    })
      .rotate()
      .resize({ width, height, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: this.quality, effort: 4, smartSubsample: true })
      .toFile(outputPath);
    return { width: info.width, height: info.height, sizeBytes: info.size };
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

  private sanitizeFilename(original: string): string {
    const cleaned = [...basename(original)]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && codePoint !== 127;
      })
      .join('')
      .trim();
    return (cleaned || 'upload').slice(0, 255);
  }

  private assertObjectId(value: string): void {
    if (!Types.ObjectId.isValid(value)) {
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'Media asset was not found',
      });
    }
  }

  private toView(asset: MediaAssetDocument): MediaAssetView {
    return {
      id: asset.id,
      originalFilename: asset.originalFilename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      checksumSha256: asset.checksumSha256,
      width: asset.width,
      height: asset.height,
      status: asset.status,
      originalUrl: `${this.mediaUrlPrefix}/${asset.id}/original`,
      variants: asset.variants.map((variant) => ({
        name: variant.name,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.sizeBytes,
        url: `${this.mediaUrlPrefix}/${asset.id}/${variant.name}`,
      })),
      createdAt: asset.get('createdAt') as Date,
    };
  }
}
