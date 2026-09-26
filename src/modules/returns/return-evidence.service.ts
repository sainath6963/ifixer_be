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
import { MongoServerError } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import sharp from 'sharp';

import {
  ReturnEvidence,
  ReturnEvidenceDocument,
} from '../../database/schemas/return-evidence.schema';
import { ReturnRequest, ReturnRequestDocument } from '../../database/schemas/return-request.schema';
import { ReturnEvidenceStatus, ReturnRequestStatus, StorageProvider } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerAuditService } from '../customer/customer-audit.service';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import type { ReturnEvidenceDelivery, ReturnEvidenceView } from './return-evidence.types';

const ALLOWED_INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);

@Injectable()
export class ReturnEvidenceService implements OnModuleInit {
  private readonly root: string;
  private readonly maxUploadBytes: number;
  private readonly maxFiles: number;
  private readonly maxInputPixels: number;
  private readonly quality: number;
  private readonly apiPrefix: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ReturnRequest.name) private readonly requests: Model<ReturnRequest>,
    @InjectModel(ReturnEvidence.name) private readonly evidence: Model<ReturnEvidence>,
    private readonly customerAudit: CustomerAuditService,
    config: ConfigService,
  ) {
    const configuredRoot = config.getOrThrow<string>('MEDIA_STORAGE_ROOT');
    this.root = isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(process.cwd(), configuredRoot);
    this.maxUploadBytes = config.getOrThrow<number>('RETURN_EVIDENCE_MAX_UPLOAD_BYTES');
    this.maxFiles = config.getOrThrow<number>('RETURN_EVIDENCE_MAX_FILES');
    this.maxInputPixels = config.getOrThrow<number>('MEDIA_MAX_INPUT_PIXELS');
    this.quality = config.getOrThrow<number>('MEDIA_WEBP_QUALITY');
    this.apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.safePath('.staging/return-evidence'), { recursive: true, mode: 0o750 });
    await mkdir(this.safePath('private/return-evidence'), { recursive: true, mode: 0o750 });
  }

  async customerList(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    returnNumber: string,
  ): Promise<ReturnEvidenceView[]> {
    const request = await this.ownedRequest(customer.id, orderNumber, returnNumber);
    const documents = await this.evidence
      .find({ returnRequestId: request._id, status: ReturnEvidenceStatus.Ready })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    return documents.map((item) => this.customerView(item, orderNumber, returnNumber));
  }

  async adminList(returnNumber: string): Promise<ReturnEvidenceView[]> {
    const request = await this.adminRequest(returnNumber);
    const documents = await this.evidence
      .find({ returnRequestId: request._id, status: ReturnEvidenceStatus.Ready })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    return documents.map((item) => this.adminView(item, returnNumber));
  }

  async upload(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    returnNumber: string,
    file: Express.Multer.File | undefined,
    context: AuthRequestContext,
  ): Promise<ReturnEvidenceView> {
    this.assertFile(file);
    const request = await this.ownedRequest(customer.id, orderNumber, returnNumber);
    if (request.status !== ReturnRequestStatus.Requested) throw this.locked();

    const evidenceId = new Types.ObjectId();
    const relativeDirectory = `private/return-evidence/${request.id.slice(0, 2)}/${request.id}`;
    const storageKey = `${relativeDirectory}/${evidenceId.toHexString()}.webp`;
    const finalPath = this.safePath(storageKey);
    const stagingDirectory = this.safePath(`.staging/return-evidence/${randomUUID()}`);
    const stagingPath = resolve(stagingDirectory, 'evidence.webp');
    await mkdir(stagingDirectory, { recursive: false, mode: 0o750 });
    let allocationReserved = false;
    let fileMoved = false;

    try {
      const output = await this.normalize(file.buffer, stagingPath);
      const checksumSha256 = createHash('sha256')
        .update(await readFile(stagingPath))
        .digest('hex');
      const safeFilename = this.sanitizeFilename(file.originalname);

      await this.connection.transaction(async (session): Promise<void> => {
        const updatedRequest = await this.requests
          .findOneAndUpdate(
            {
              _id: request._id,
              customerId: new Types.ObjectId(customer.id),
              orderNumber,
              returnNumber,
              status: ReturnRequestStatus.Requested,
              evidenceCount: { $lt: this.maxFiles },
            },
            { $inc: { evidenceCount: 1, version: 1 } },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!updatedRequest) await this.throwAllocationFailure(request._id, session);
        await this.evidence.create(
          [
            {
              _id: evidenceId,
              returnRequestId: request._id,
              orderId: request.orderId,
              customerId: request.customerId,
              storageProvider: StorageProvider.Local,
              storageKey,
              originalFilename: safeFilename,
              mimeType: 'image/webp',
              sizeBytes: output.sizeBytes,
              width: output.width,
              height: output.height,
              checksumSha256,
              status: ReturnEvidenceStatus.Pending,
            },
          ],
          { session },
        );
      }, this.transactionOptions());
      allocationReserved = true;

      await mkdir(dirname(finalPath), { recursive: true, mode: 0o750 });
      await rename(stagingPath, finalPath);
      fileMoved = true;
      const ready = await this.connection.transaction(async (session) => {
        const updated = await this.evidence
          .findOneAndUpdate(
            { _id: evidenceId, status: ReturnEvidenceStatus.Pending },
            { $set: { status: ReturnEvidenceStatus.Ready } },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!updated) {
          throw new ConflictException({
            code: 'RETURN_EVIDENCE_STATE_CONFLICT',
            message: 'Evidence state changed while completing upload',
          });
        }
        await this.customerAudit.record(
          {
            action: 'RETURN_EVIDENCE_UPLOADED',
            resourceType: 'RETURN_EVIDENCE',
            resourceId: updated.id,
            actorId: customer.id,
            context,
            metadata: { returnNumber, orderNumber, width: updated.width, height: updated.height },
          },
          session,
        );
        return updated;
      }, this.transactionOptions());
      await rm(stagingDirectory, { recursive: true, force: true });
      return this.customerView(ready, orderNumber, returnNumber);
    } catch (error: unknown) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (fileMoved) await rm(finalPath, { force: true });
      if (allocationReserved) await this.releaseFailedAllocation(request._id, evidenceId);
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ConflictException({
          code: 'RETURN_EVIDENCE_DUPLICATE',
          message: 'This evidence image is already attached to the request',
        });
      }
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new InternalServerErrorException({
        code: 'RETURN_EVIDENCE_STORAGE_FAILED',
        message: 'Evidence image could not be stored safely',
      });
    }
  }

  async customerDelete(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    returnNumber: string,
    evidenceId: string,
    context: AuthRequestContext,
  ): Promise<void> {
    this.assertObjectId(evidenceId);
    const deleted = await this.connection.transaction(async (session) => {
      const request = await this.requests
        .findOne({
          customerId: new Types.ObjectId(customer.id),
          orderNumber,
          returnNumber,
        })
        .session(session)
        .exec();
      if (!request) throw this.notFound();
      if (request.status !== ReturnRequestStatus.Requested) throw this.locked();
      const item = await this.evidence
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(evidenceId),
            returnRequestId: request._id,
            customerId: request.customerId,
            status: ReturnEvidenceStatus.Ready,
          },
          { $set: { status: ReturnEvidenceStatus.Deleted, deletedAt: new Date() } },
          { session, returnDocument: 'after' },
        )
        .exec();
      if (!item) throw this.evidenceNotFound();
      request.evidenceCount = Math.max(0, (request.evidenceCount ?? 0) - 1);
      await request.save({ session });
      await this.customerAudit.record(
        {
          action: 'RETURN_EVIDENCE_DELETED',
          resourceType: 'RETURN_EVIDENCE',
          resourceId: item.id,
          actorId: customer.id,
          context,
          metadata: { returnNumber, orderNumber },
        },
        session,
      );
      return item;
    }, this.transactionOptions());
    await rm(this.safePath(deleted.storageKey), { force: true });
  }

  async customerDelivery(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    returnNumber: string,
    evidenceId: string,
  ): Promise<ReturnEvidenceDelivery> {
    const request = await this.ownedRequest(customer.id, orderNumber, returnNumber);
    return this.delivery(request, evidenceId);
  }

  async adminDelivery(returnNumber: string, evidenceId: string): Promise<ReturnEvidenceDelivery> {
    const request = await this.adminRequest(returnNumber);
    return this.delivery(request, evidenceId);
  }

  private async delivery(
    request: ReturnRequestDocument,
    evidenceId: string,
  ): Promise<ReturnEvidenceDelivery> {
    this.assertObjectId(evidenceId);
    const item = await this.evidence
      .findOne({
        _id: new Types.ObjectId(evidenceId),
        returnRequestId: request._id,
        status: ReturnEvidenceStatus.Ready,
      })
      .exec();
    if (!item) throw this.evidenceNotFound();
    try {
      const filePath = this.safePath(item.storageKey);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error('Not a file');
      return {
        stream: createReadStream(filePath),
        sizeBytes: fileStat.size,
        mimeType: item.mimeType,
      };
    } catch {
      throw new NotFoundException({
        code: 'RETURN_EVIDENCE_FILE_MISSING',
        message: 'Evidence image is unavailable',
      });
    }
  }

  private async ownedRequest(
    customerId: string,
    orderNumber: string,
    returnNumber: string,
  ): Promise<ReturnRequestDocument> {
    const request = await this.requests
      .findOne({ customerId: new Types.ObjectId(customerId), orderNumber, returnNumber })
      .exec();
    if (!request) throw this.notFound();
    return request;
  }

  private async adminRequest(returnNumber: string): Promise<ReturnRequestDocument> {
    const request = await this.requests.findOne({ returnNumber }).exec();
    if (!request) throw this.notFound();
    return request;
  }

  private async normalize(
    input: Buffer,
    outputPath: string,
  ): Promise<{ width: number; height: number; sizeBytes: number }> {
    try {
      const image = sharp(input, {
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
        throw new Error('Unsupported image');
      }
      const result = await sharp(input, {
        failOn: 'warning',
        limitInputPixels: this.maxInputPixels,
        pages: 1,
      })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: this.quality, effort: 4, smartSubsample: true })
        .toFile(outputPath);
      return { width: result.width, height: result.height, sizeBytes: result.size };
    } catch {
      throw new BadRequestException({
        code: 'RETURN_EVIDENCE_IMAGE_INVALID',
        message: 'Only safe single-frame JPEG, PNG, WebP, and AVIF images are supported',
      });
    }
  }

  private assertFile(file: Express.Multer.File | undefined): asserts file is Express.Multer.File {
    if (!file?.buffer?.length) {
      throw new BadRequestException({
        code: 'RETURN_EVIDENCE_FILE_REQUIRED',
        message: 'Evidence image is required',
      });
    }
    if (file.size > this.maxUploadBytes) {
      throw new BadRequestException({
        code: 'RETURN_EVIDENCE_TOO_LARGE',
        message: `Evidence image exceeds the ${this.maxUploadBytes}-byte limit`,
      });
    }
  }

  private async throwAllocationFailure(
    requestId: Types.ObjectId,
    session: ClientSession,
  ): Promise<never> {
    const current = await this.requests.findById(requestId).session(session).exec();
    if (!current) throw this.notFound();
    if (current.status !== ReturnRequestStatus.Requested) throw this.locked();
    throw new ConflictException({
      code: 'RETURN_EVIDENCE_LIMIT_REACHED',
      message: `A return request supports at most ${this.maxFiles} evidence images`,
    });
  }

  private async releaseFailedAllocation(
    requestId: Types.ObjectId,
    evidenceId: Types.ObjectId,
  ): Promise<void> {
    await this.connection.transaction(async (session): Promise<void> => {
      const removed = await this.evidence.deleteOne(
        { _id: evidenceId, status: ReturnEvidenceStatus.Pending },
        { session },
      );
      if (removed.deletedCount) {
        await this.requests.updateOne(
          { _id: requestId, evidenceCount: { $gt: 0 } },
          { $inc: { evidenceCount: -1, version: 1 } },
          { session },
        );
      }
    }, this.transactionOptions());
  }

  private customerView(
    item: ReturnEvidenceDocument,
    orderNumber: string,
    returnNumber: string,
  ): ReturnEvidenceView {
    return {
      ...this.baseView(item),
      contentUrl: `/${this.apiPrefix}/customer/orders/${orderNumber}/returns/${returnNumber}/evidence/${item.id}/content`,
    };
  }

  private adminView(item: ReturnEvidenceDocument, returnNumber: string): ReturnEvidenceView {
    return {
      ...this.baseView(item),
      contentUrl: `/${this.apiPrefix}/admin/returns/${returnNumber}/evidence/${item.id}/content`,
    };
  }

  private baseView(item: ReturnEvidenceDocument): Omit<ReturnEvidenceView, 'contentUrl'> {
    return {
      id: item.id,
      originalFilename: item.originalFilename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      createdAt: item.get('createdAt') as Date,
    };
  }

  private safePath(storageKey: string): string {
    const path = resolve(this.root, storageKey);
    const relativePath = relative(this.root, path);
    if (
      relativePath === '' ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath === '..' ||
      isAbsolute(relativePath)
    ) {
      throw new Error('Unsafe evidence storage path');
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
    return (cleaned || 'evidence').slice(0, 255);
  }

  private assertObjectId(value: string): void {
    if (!Types.ObjectId.isValid(value)) throw this.evidenceNotFound();
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'RETURN_REQUEST_NOT_FOUND',
      message: 'Return request was not found',
    });
  }

  private evidenceNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'RETURN_EVIDENCE_NOT_FOUND',
      message: 'Evidence image was not found',
    });
  }

  private locked(): ConflictException {
    return new ConflictException({
      code: 'RETURN_EVIDENCE_LOCKED',
      message: 'Evidence can be changed only while the request is pending review',
    });
  }

  private transactionOptions(): {
    readPreference: 'primary';
    readConcern: { level: 'snapshot' };
    writeConcern: { w: 'majority' };
  } {
    return {
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    };
  }
}
