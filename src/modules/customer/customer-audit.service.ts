import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';

import { AuditLog } from '../../database/schemas/operations.schema';
import { AuditActorType } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerTokenService } from './customer-token.service';

interface CustomerAuditEvent {
  action: string;
  resourceType:
    | 'CUSTOMER_AUTH'
    | 'REPAIR_BOOKING'
    | 'CUSTOMER_SESSION'
    | 'CUSTOMER_USER'
    | 'CUSTOMER_ACTION_TOKEN'
    | 'CUSTOMER_ADDRESS'
    | 'CART'
    | 'ORDER'
    | 'PAYMENT'
    | 'RETURN_REQUEST'
    | 'RETURN_EVIDENCE'
    | 'PRODUCT_REVIEW'
    | 'WISHLIST'
    | 'STOCK_ALERT';
  resourceId: string;
  actorId?: string;
  context?: AuthRequestContext;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class CustomerAuditService {
  constructor(
    @InjectModel(AuditLog.name) private readonly auditLogs: Model<AuditLog>,
    private readonly tokens: CustomerTokenService,
  ) {}

  async record(event: CustomerAuditEvent, session?: ClientSession): Promise<void> {
    await this.auditLogs.create(
      [
        {
          actorType: event.actorId ? AuditActorType.Customer : AuditActorType.System,
          actorId: event.actorId ? new Types.ObjectId(event.actorId) : undefined,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          requestId: event.context?.requestId,
          ipHash: event.context?.ipAddress
            ? this.tokens.hashToken(event.context.ipAddress)
            : undefined,
          metadata: event.metadata ?? {},
          occurredAt: new Date(),
        },
      ],
      { session },
    );
  }
}
