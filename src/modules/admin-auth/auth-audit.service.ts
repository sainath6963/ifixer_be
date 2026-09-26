import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';

import { AuditLog } from '../../database/schemas/operations.schema';
import { AuditActorType } from '../../domain/enums';
import type { AuthRequestContext } from './auth.types';
import { AdminTokenService } from './token.service';

export interface AuthAuditEvent {
  action: string;
  resourceType:
    | 'ADMIN_AUTH'
    | 'INSTAGRAM_REEL'
    | 'REPAIR_CATALOG'
    | 'REPAIR_BOOKING'
    | 'REPAIR_JOB'
    | 'REPAIR_INVENTORY'
    | 'REPAIR_BILLING'
    | 'ADMIN_SESSION'
    | 'ADMIN_USER'
    | 'CATEGORY'
    | 'PRODUCT'
    | 'MEDIA_ASSET'
    | 'INVENTORY_LEVEL'
    | 'ORDER'
    | 'PAYMENT'
    | 'REFUND'
    | 'RETURN_REQUEST'
    | 'RETURN_EVIDENCE'
    | 'NOTIFICATION'
    | 'OUTBOX_EVENT'
    | 'COUPON'
    | 'PRODUCT_REVIEW';
  resourceId: string;
  actorId?: string;
  context?: AuthRequestContext;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuthAuditService {
  constructor(
    @InjectModel(AuditLog.name) private readonly auditLogs: Model<AuditLog>,
    private readonly tokens: AdminTokenService,
  ) {}

  async record(event: AuthAuditEvent, session?: ClientSession): Promise<void> {
    await this.auditLogs.create(
      [
        {
          actorType: event.actorId ? AuditActorType.Admin : AuditActorType.System,
          actorId: event.actorId ? new Types.ObjectId(event.actorId) : undefined,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          requestId: event.context?.requestId,
          ipHash: event.context?.ipAddress
            ? this.tokens.hashSensitiveValue(event.context.ipAddress)
            : undefined,
          metadata: event.metadata ?? {},
          occurredAt: new Date(),
        },
      ],
      { session },
    );
  }
}
