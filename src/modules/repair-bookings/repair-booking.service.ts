import type { RepairBookingView, RepairBookingPage } from './repair-booking.types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';
import {
  RepairBooking,
  RepairBookingDocument,
  RepairBookingStatus,
} from '../../database/schemas/repair.schema';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerAuditService } from '../customer/customer-audit.service';
import { RepairCatalogService } from '../repair-catalog/repair-catalog.service';
import type {
  BookingChangeDto,
  BookingListDto,
  CreateRepairBookingDto,
} from './repair-booking.dto';

export interface BookingActor {
  adminId?: string;
  customerId?: string;
  token?: string;
  context: AuthRequestContext;
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export function validateVisit(value?: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getTime() <= Date.now() ||
    date.getTime() > Date.now() + 180 * 86400000
  ) {
    throw new BadRequestException({
      code: 'REPAIR_VISIT_INVALID',
      message: 'Choose a future visit time within the next 180 days',
    });
  }
  return date;
}

@Injectable()
export class RepairBookingService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(RepairBooking.name) private readonly bookings: Model<RepairBooking>,
    private readonly catalog: RepairCatalogService,
    private readonly audit: AuthAuditService,
    private readonly customerAudit: CustomerAuditService,
  ) {}

  async create(input: CreateRepairBookingDto, actor: BookingActor): Promise<RepairBookingView> {
    const operationKey = `${actor.adminId ? 'walk-in' : 'online'}:${input.idempotencyKey}`;
    // A stable field order makes retries independent of JSON property ordering.
    const requestHash = hash(
      JSON.stringify([
        actor.adminId ?? null,
        actor.customerId ?? null,
        input.customerName,
        input.phone,
        input.email ?? null,
        input.brandId ?? null,
        input.modelId ?? null,
        input.serviceId ?? null,
        input.deviceDescription ?? null,
        input.issue,
        input.requestedVisitAt ?? null,
        input.manageToken,
      ]),
    );
    const replay = async (): Promise<RepairBookingView | null> => {
      const existing = await this.bookings.findOne({ operationKey });
      if (!existing) return null;
      if (existing.requestHash !== requestHash)
        throw new ConflictException({
          code: 'REPAIR_REQUEST_KEY_REUSED',
          message:
            'This request key was already used for different details. Restore the original request or start a new one.',
        });
      return this.view(existing, Boolean(actor.adminId));
    };
    const existing = await replay();
    if (existing) return existing;
    const requestedVisitAt = validateVisit(input.requestedVisitAt);
    try {
      const document = await this.connection.transaction(async (session) => {
        const selection = await this.catalog.resolveSelection(input, session);
        const [created] = await this.bookings.create(
          [
            {
              ...selection,
              reference: `IFX-${randomBytes(8).toString('hex').toUpperCase()}`,
              operationKey,
              requestHash,
              manageTokenHash: hash(input.manageToken),
              customerId: actor.customerId ? new Types.ObjectId(actor.customerId) : undefined,
              source: actor.adminId ? 'WALK_IN' : 'ONLINE',
              customerName: input.customerName,
              phone: input.phone,
              email: input.email,
              issue: input.issue,
              requestedVisitAt,
              status: RepairBookingStatus.Requested,
              history: [
                {
                  at: new Date(),
                  actor: this.actorType(actor),
                  actorId: this.actorId(actor),
                  action: 'CREATE',
                  status: RepairBookingStatus.Requested,
                  reason: actor.adminId
                    ? 'Walk-in request recorded by staff'
                    : 'Repair request submitted',
                  visitAt: requestedVisitAt,
                },
              ],
            },
          ],
          { session },
        );
        await this.record('REPAIR_BOOKING_CREATED', created, actor, session);
        return created;
      });
      return this.view(document, Boolean(actor.adminId));
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const result = await replay();
        if (result) return result;
      }
      throw error;
    }
  }

  async get(reference: string, actor: BookingActor): Promise<RepairBookingView> {
    return this.view(await this.find(reference, actor), Boolean(actor.adminId));
  }

  async list(query: BookingListDto): Promise<RepairBookingPage> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = ['reference', 'customerName', 'phone', 'deviceLabel'].map((field) => ({
        [field]: { $regex: escaped, $options: 'i' },
      }));
    }
    const [documents, total] = await Promise.all([
      this.bookings
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.bookings.countDocuments(filter),
    ]);
    return {
      items: documents.map((doc) => this.view(doc, true)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async change(
    reference: string,
    input: BookingChangeDto,
    actor: BookingActor,
  ): Promise<RepairBookingView> {
    if (input.action === 'CONFIRM' && !actor.adminId)
      throw new BadRequestException('Only staff can confirm an appointment');
    const visitAt = input.action === 'CANCEL' ? undefined : validateVisit(input.visitAt);
    if (input.action !== 'CANCEL' && !visitAt)
      throw new BadRequestException('A visit time is required');
    if (input.action === 'CANCEL' && input.visitAt !== undefined)
      throw new BadRequestException('Cancellation cannot include a visit time');
    const document = await this.connection.transaction(async (session) => {
      const current = await this.find(reference, actor, session);
      if ((current.get('version') as number) !== input.expectedVersion) this.changed();
      if (![RepairBookingStatus.Requested, RepairBookingStatus.Confirmed].includes(current.status))
        throw new ConflictException({
          code: 'REPAIR_BOOKING_CLOSED',
          message: 'This booking is closed and cannot be changed',
        });
      if (input.action === 'CONFIRM' && current.status !== RepairBookingStatus.Requested)
        throw new ConflictException('The visit is already confirmed; use reschedule to change it');
      const status =
        input.action === 'CANCEL'
          ? RepairBookingStatus.Cancelled
          : actor.adminId
            ? RepairBookingStatus.Confirmed
            : RepairBookingStatus.Requested;
      const set: Record<string, unknown> = { status };
      const unset: Record<string, 1> = {};
      if (status === RepairBookingStatus.Confirmed) set.confirmedVisitAt = visitAt;
      else {
        unset.confirmedVisitAt = 1;
        if (input.action === 'RESCHEDULE') set.requestedVisitAt = visitAt;
      }
      const updated = await this.bookings.findOneAndUpdate(
        { _id: current._id, version: input.expectedVersion, status: current.status },
        {
          $set: set,
          $unset: unset,
          $inc: { version: 1 },
          $push: {
            history: {
              at: new Date(),
              actor: this.actorType(actor),
              actorId: this.actorId(actor),
              action: input.action,
              status,
              reason: input.reason,
              visitAt,
            },
          },
        },
        { session, returnDocument: 'after', runValidators: true },
      );
      if (!updated) this.changed();
      await this.record(`REPAIR_BOOKING_${input.action}`, updated, actor, session);
      return updated;
    });
    return this.view(document, Boolean(actor.adminId));
  }

  private async find(
    reference: string,
    actor: BookingActor,
    session?: ClientSession,
  ): Promise<RepairBookingDocument> {
    if (!/^IFX-[A-F0-9]{16}$/.test(reference))
      throw new NotFoundException('Booking not found or access unavailable');
    const access: Record<string, unknown>[] = [];
    if (actor.customerId) access.push({ customerId: new Types.ObjectId(actor.customerId) });
    if (actor.token && /^[a-f0-9]{64}$/.test(actor.token))
      access.push({ manageTokenHash: hash(actor.token) });
    if (!actor.adminId && !access.length)
      throw new NotFoundException('Booking not found or access unavailable');
    const query = this.bookings.findOne({ reference, ...(actor.adminId ? {} : { $or: access }) });
    if (session) query.session(session);
    const booking = await query;
    if (!booking) throw new NotFoundException('Booking not found or access unavailable');
    return booking;
  }

  private view(doc: RepairBookingDocument, admin: boolean): RepairBookingView {
    return {
      reference: doc.reference,
      customerName: doc.customerName,
      phone: doc.phone,
      email: doc.email,
      deviceLabel: doc.deviceLabel,
      serviceLabel: doc.serviceLabel,
      issue: doc.issue,
      pricingMode: doc.pricingMode,
      indicativePriceInPaise: doc.indicativePriceInPaise,
      requestedVisitAt: doc.requestedVisitAt,
      confirmedVisitAt: doc.confirmedVisitAt,
      status: doc.status,
      version: doc.get('version') as number,
      createdAt: doc.get('createdAt') as Date,
      history: doc.history.map((event) => ({
        at: event.at,
        action: event.action,
        status: event.status,
        reason: event.reason,
        visitAt: event.visitAt,
        ...(admin ? { actor: event.actor, actorId: event.actorId?.toHexString() } : {}),
      })),
      ...(admin
        ? {
            source: doc.source,
            jobNumber: doc.jobNumber,
            customerId: doc.customerId?.toHexString(),
            brandId: doc.brandId?.toHexString(),
            modelId: doc.modelId?.toHexString(),
            serviceId: doc.serviceId?.toHexString(),
          }
        : {}),
    };
  }
  private actorType(actor: BookingActor): string {
    return actor.adminId ? 'ADMIN' : actor.customerId ? 'CUSTOMER' : 'GUEST';
  }
  private actorId(actor: BookingActor): Types.ObjectId | undefined {
    const id = actor.adminId ?? actor.customerId;
    return id ? new Types.ObjectId(id) : undefined;
  }
  private async record(
    action: string,
    doc: RepairBookingDocument,
    actor: BookingActor,
    session: ClientSession,
  ): Promise<void> {
    const event = {
      action,
      resourceType: 'REPAIR_BOOKING' as const,
      resourceId: doc.id,
      actorId: actor.adminId ?? actor.customerId,
      context: actor.context,
      metadata: {
        reference: doc.reference,
        status: doc.status,
        version: doc.get('version') as number,
      },
    };
    if (actor.adminId) await this.audit.record(event, session);
    else await this.customerAudit.record(event, session);
  }
  private changed(): never {
    throw new ConflictException({
      code: 'REPAIR_BOOKING_CHANGED',
      message: 'This booking changed. Refresh its details before trying again.',
    });
  }
}
