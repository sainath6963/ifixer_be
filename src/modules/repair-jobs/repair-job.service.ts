import { RepairBillingService } from '../repair-billing/repair-billing.service';
import { RepairInventoryService } from '../repair-inventory/repair-inventory.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { createHash, randomBytes } from 'node:crypto';
import sharp, { type OutputInfo } from 'sharp';
import {
  RepairJob,
  RepairJobDocument,
  RepairJobEvent,
  RepairJobPhoto,
  RepairJobStatus as Status,
  repairTestKeys,
} from '../../database/schemas/repair-job.schema';
import { RepairBooking, RepairBookingStatus } from '../../database/schemas/repair.schema';
import { AdminUser, AdminSession } from '../../database/schemas/identity.schema';
import { AdminRole, AccountStatus } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import { PasswordService } from '../admin-auth/password.service';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { validateVisit } from '../repair-bookings/repair-booking.service';
import type {
  CreateJobDto,
  JobApprovalDto,
  JobAssignmentDto,
  JobEstimateDto,
  JobListDto,
  JobReturnDto,
  JobTestsDto,
  JobTextDto,
  JobTransitionDto,
  CreateRepairMemberDto,
  RepairMemberStatusDto,
} from './repair-job.dto';

export interface JobPhotoView {
  id: string;
  width: number;
  height: number;
  createdAt: Date;
  url: string;
}
export interface RepairJobView {
  number: string;
  bookingReference?: string;
  billingInvoiceNumber?: string;
  warrantySourceJobNumber?: string;
  warrantySourceInvoiceNumber?: string;
  version: number;
  customerName: string;
  phone?: string;
  email?: string;
  deviceLabel: string;
  imei?: string;
  serial?: string;
  issue: string;
  condition: string;
  accessories: string;
  targetAt?: Date;
  technicianId?: string;
  technicianName?: string;
  status: Status;
  custody: string;
  returnedAt?: Date;
  returnedTo?: string;
  diagnosis?: string;
  createdAt: Date;
  estimates: Array<{
    revision: number;
    lines: RepairJob['estimates'][number]['lines'];
    totalInPaise: number;
    reason: string;
    at: Date;
    approval?: {
      decision: string;
      method: string;
      customerName: string;
      evidence: string;
      at: Date;
    };
  }>;
  tests: RepairJob['tests'];
  history: Array<{ at: Date; actorName: string; action: string; status: Status; reason: string }>;
  photos: JobPhotoView[];
  permissions: { manage: boolean; repair: boolean };
}
export interface RepairTeamMember {
  id: string;
  name: string;
  email?: string;
  roles: AdminRole[];
  status: AccountStatus;
  version: number;
}
const terminal = [Status.Delivered, Status.Cancelled, Status.Unrepairable];
export const canManageJobs = (admin: AuthenticatedAdmin): boolean =>
  admin.roles.some((role) =>
    [AdminRole.Owner, AdminRole.Staff, AdminRole.Reception].includes(role),
  );
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

@Injectable()
export class RepairJobService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(RepairJob.name) private readonly jobs: Model<RepairJob>,
    @InjectModel(RepairBooking.name) private readonly bookings: Model<RepairBooking>,
    @InjectModel(RepairJobPhoto.name) private readonly photos: Model<RepairJobPhoto>,
    @InjectModel(AdminUser.name) private readonly users: Model<AdminUser>,
    private readonly inventory: RepairInventoryService,
    private readonly billing: RepairBillingService,
    private readonly audit: AuthAuditService,
    private readonly passwords: PasswordService,
  ) {}

  async create(input: CreateJobDto, admin: AuthenticatedAdmin): Promise<RepairJobView> {
    this.requireManage(admin);
    if (input.bookingReference) {
      if (input.expectedBookingVersion === undefined)
        throw new BadRequestException('Booking version is required');
      if (
        [input.customerName, input.phone, input.email, input.deviceLabel, input.issue].some(
          (item) => item !== undefined,
        )
      )
        throw new BadRequestException(
          'A converted job uses the booking customer, device and issue',
        );
    } else if (
      !input.customerName ||
      !input.phone ||
      !input.deviceLabel ||
      !input.issue ||
      input.expectedBookingVersion !== undefined
    )
      throw new BadRequestException('Walk-in jobs require customer, phone, device and issue');
    const operationKey = `${admin.id}:${input.idempotencyKey}`;
    const requestHash = hash(
      JSON.stringify(
        Object.keys(input)
          .sort()
          .map((key) => [key, input[key as keyof CreateJobDto]]),
      ),
    );
    const replay = async (): Promise<RepairJobDocument | null> => {
      const sameKey = await this.jobs.findOne({ operationKey });
      if (sameKey && sameKey.requestHash !== requestHash)
        throw new ConflictException('Request key already used for different intake details');
      if (sameKey) return sameKey;
      return input.bookingReference
        ? this.jobs.findOne({ bookingReference: input.bookingReference })
        : null;
    };
    const prior = await replay();
    if (prior) return this.view(prior, admin);
    const targetAt = validateVisit(input.targetAt);
    try {
      const job = await this.connection.transaction(async (session) => {
        const booking = input.bookingReference
          ? await this.bookings.findOne({ reference: input.bookingReference }).session(session)
          : null;
        if (input.bookingReference && !booking) throw new NotFoundException('Booking not found');
        if (
          booking &&
          (booking.get('version') !== input.expectedBookingVersion ||
            ![RepairBookingStatus.Requested, RepairBookingStatus.Confirmed].includes(
              booking.status,
            ))
        )
          throw new ConflictException('Booking changed or is closed. Refresh before intake.');
        const [created] = await this.jobs.create(
          [
            {
              number: `JOB-${randomBytes(8).toString('hex').toUpperCase()}`,
              operationKey,
              requestHash,
              bookingId: booking?._id,
              bookingReference: booking?.reference,
              customerId: booking?.customerId,
              modelId: booking?.modelId,
              customerName: booking?.customerName ?? input.customerName,
              phone: booking?.phone ?? input.phone,
              email: booking?.email ?? input.email,
              deviceLabel: booking?.deviceLabel ?? input.deviceLabel,
              issue: booking?.issue ?? input.issue,
              imei: input.imei,
              serial: input.serial,
              condition: input.condition,
              accessories: input.accessories,
              targetAt,
              history: [
                this.event(admin, 'INTAKE', Status.Received, 'Device received into shop custody'),
              ],
            },
          ],
          { session },
        );
        if (booking) {
          const updated = await this.bookings.updateOne(
            { _id: booking._id, version: input.expectedBookingVersion, status: booking.status },
            {
              $set: { status: RepairBookingStatus.Converted, jobNumber: created.number },
              $inc: { version: 1 },
              $push: {
                history: {
                  at: new Date(),
                  actor: 'ADMIN',
                  actorId: new Types.ObjectId(admin.id),
                  action: 'CONVERT',
                  status: RepairBookingStatus.Converted,
                  reason: 'Device received; repair job card opened',
                },
              },
            },
            { session, runValidators: true },
          );
          if (updated.modifiedCount !== 1) this.changed();
          await this.audit.record(
            {
              action: 'REPAIR_BOOKING_CONVERTED',
              resourceType: 'REPAIR_BOOKING',
              resourceId: booking.id,
              actorId: admin.id,
              metadata: { jobNumber: created.number },
            },
            session,
          );
        }
        await this.record(created, admin, 'INTAKE', session);
        return created;
      });
      return this.view(job, admin);
    } catch (error) {
      // Both the unique booking index and the transaction's booking version protect conversion.
      if (
        (error instanceof MongoServerError && error.code === 11000) ||
        error instanceof ConflictException
      ) {
        const existing = await replay();
        if (existing) return this.view(existing, admin);
      }
      throw error;
    }
  }

  async list(
    query: JobListDto,
    admin: AuthenticatedAdmin,
  ): Promise<{ items: RepairJobView[]; page: number; total: number; totalPages: number }> {
    const filter: Record<string, unknown> = canManageJobs(admin)
      ? {}
      : { technicianId: new Types.ObjectId(admin.id) };
    if (query.status) filter.status = query.status;
    if (query.custody) filter.custody = query.custody;
    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        'number',
        'bookingReference',
        'customerName',
        'deviceLabel',
        ...(canManageJobs(admin) ? ['phone'] : []),
      ].map((field) => ({ [field]: { $regex: escaped, $options: 'i' } }));
    }
    const [rows, total] = await Promise.all([
      this.jobs
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.jobs.countDocuments(filter),
    ]);
    return {
      items: await Promise.all(rows.map((job) => this.view(job, admin, false))),
      page: query.page,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }
  async get(number: string, admin: AuthenticatedAdmin): Promise<RepairJobView> {
    return this.view(await this.find(number, admin), admin);
  }

  async assign(
    number: string,
    input: JobAssignmentDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    this.requireManage(admin);
    return this.mutate(
      number,
      input.expectedVersion,
      admin,
      'ASSIGN',
      input.reason,
      async (job, session) => {
        this.requireOpen(job);
        const technician = await this.users
          .findOne({
            _id: input.technicianId,
            status: AccountStatus.Active,
            roles: AdminRole.Technician,
          })
          .session(session);
        if (!technician) throw new BadRequestException('Choose an active technician');
        job.technicianId = technician._id;
        job.technicianName = technician.name;
      },
    );
  }
  async diagnose(
    number: string,
    input: JobTextDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.mutate(number, input.expectedVersion, admin, 'DIAGNOSIS', input.text, (job) => {
      this.requireRepair(job, admin);
      if (job.status !== Status.Diagnosing)
        throw new ConflictException('Diagnosis can be recorded while diagnosing');
      job.diagnosis = input.text;
    });
  }
  async note(number: string, input: JobTextDto, admin: AuthenticatedAdmin): Promise<RepairJobView> {
    return this.mutate(number, input.expectedVersion, admin, 'NOTE', input.text, () => undefined);
  }
  async estimate(
    number: string,
    input: JobEstimateDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    this.requireManage(admin);
    const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceInPaise, 0);
    if (!Number.isSafeInteger(total) || total > 1000000000)
      throw new BadRequestException('Estimate total exceeds the supported amount');
    return this.mutate(
      number,
      input.expectedVersion,
      admin,
      'ESTIMATE',
      input.reason,
      async (job, session) => {
        this.requireOpen(job);
        await this.billing.assertEstimateOpen(job, session);
        if (!job.diagnosis || job.status === Status.Received)
          throw new ConflictException('Record a diagnosis before creating an estimate');
        if (job.estimates.length >= 100)
          throw new ConflictException('Estimate revision limit reached');
        await this.inventory.releaseForJob(
          job,
          admin,
          'Unused allocation released for a revised estimate',
          session,
        );
        job.estimates.push({
          revision: job.estimates.length + 1,
          lines: input.lines,
          totalInPaise: total,
          reason: input.reason,
          at: new Date(),
          createdBy: new Types.ObjectId(admin.id),
        });
        job.status = Status.AwaitingApproval;
        job.tests = [];
      },
    );
  }
  async approve(
    number: string,
    input: JobApprovalDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    this.requireManage(admin);
    return this.mutate(
      number,
      input.expectedVersion,
      admin,
      'APPROVAL',
      `Estimate ${input.revision}: ${input.decision}. ${input.evidence}`,
      (job) => {
        const current = job.estimates.at(-1);
        if (
          job.status !== Status.AwaitingApproval ||
          !current ||
          current.revision !== input.revision ||
          current.approval
        )
          throw new ConflictException(
            'Only the latest undecided estimate can receive a customer decision',
          );
        current.approval = {
          decision: input.decision,
          method: input.method,
          customerName: input.customerName,
          evidence: input.evidence,
          at: new Date(),
          recordedBy: new Types.ObjectId(admin.id),
        };
      },
    );
  }
  async test(
    number: string,
    input: JobTestsDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    if (
      new Set(input.tests.map((test) => test.key)).size !== repairTestKeys.length ||
      input.tests.some((test) => test.result !== 'PASS' && (!test.notes || test.notes.length < 3))
    )
      throw new BadRequestException(
        'Record each test once and explain failed or not-applicable checks',
      );
    return this.mutate(
      number,
      input.expectedVersion,
      admin,
      'TESTS',
      input.tests
        .map((test) => `${test.key}: ${test.result}${test.notes ? ` (${test.notes})` : ''}`)
        .join('; ')
        .slice(0, 2000),
      (job) => {
        this.requireRepair(job, admin);
        if (job.status !== Status.Testing)
          throw new ConflictException('Move the job to testing before recording results');
        job.tests = input.tests;
      },
    );
  }
  async transition(
    number: string,
    input: JobTransitionDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    return this.mutate(
      number,
      input.expectedVersion,
      admin,
      'STATUS',
      input.reason,
      async (job, session) => {
        this.requireOpen(job);
        const next = input.status;
        if ([Status.Cancelled, Status.Unrepairable, Status.Delivered].includes(next))
          this.requireManage(admin);
        else this.requireRepair(job, admin);
        if ([Status.Cancelled, Status.Unrepairable].includes(next)) {
          await this.inventory.releaseForJob(job, admin, input.reason, session);
          job.status = next;
          return;
        }
        const allowed: Partial<Record<Status, Status[]>> = {
          [Status.Received]: [Status.Diagnosing],
          [Status.Diagnosing]: [Status.AwaitingParts],
          [Status.AwaitingApproval]: [Status.AwaitingParts, Status.Repairing],
          [Status.AwaitingParts]: [Status.Diagnosing, Status.Repairing],
          [Status.Repairing]: [Status.AwaitingParts, Status.Testing],
          [Status.Testing]: [Status.Repairing, Status.Ready],
          [Status.Ready]: [Status.Delivered, Status.Repairing],
        };
        if (!allowed[job.status]?.includes(next))
          throw new ConflictException('That repair status transition is not allowed');
        if (next === Status.Diagnosing && job.estimates.length)
          throw new ConflictException('Use a revised estimate for additional diagnosed work');
        if (
          [Status.Repairing, Status.Testing, Status.Ready, Status.Delivered].includes(next) &&
          job.estimates.at(-1)?.approval?.decision !== 'APPROVED'
        )
          throw new ConflictException('Customer approval of the latest estimate is required');
        if (
          next === Status.Ready &&
          (job.tests.length !== repairTestKeys.length ||
            job.tests.some((test) => test.result === 'FAIL'))
        )
          throw new ConflictException('Complete all tests successfully before marking ready');
        if (next === Status.Repairing) job.tests = [];
        if (next === Status.Delivered) {
          if (!input.recipient) throw new BadRequestException('Record who collected the device');
          await this.billing.assertHandover(job, session, true);
          await this.inventory.releaseForJob(
            job,
            admin,
            'Unused allocation released at handover',
            session,
          );
          job.custody = 'RETURNED';
          job.returnedAt = new Date();
          job.returnedTo = input.recipient;
        } else if (input.recipient)
          throw new BadRequestException('Recipient is only used for handover');
        job.status = next;
      },
    );
  }
  async returnDevice(
    number: string,
    input: JobReturnDto,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    this.requireManage(admin);
    return this.mutate(
      number,
      input.expectedVersion,
      admin,
      'RETURN_DEVICE',
      input.reason,
      async (job, session) => {
        if (
          ![Status.Cancelled, Status.Unrepairable].includes(job.status) ||
          job.custody !== 'IN_SHOP'
        )
          throw new ConflictException(
            'Only an unreturned cancelled or unrepairable device can be handed back here',
          );
        await this.billing.assertHandover(job, session, false);
        job.custody = 'RETURNED';
        job.returnedAt = new Date();
        job.returnedTo = input.recipient;
      },
    );
  }

  async upload(
    number: string,
    version: number,
    file: Express.Multer.File | undefined,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    await this.find(number, admin);
    if (!file?.buffer || file.size > 10485760)
      throw new BadRequestException('Choose a JPEG, PNG, WebP or AVIF image up to 10 MB');
    let result: { data: Buffer; info: OutputInfo };
    try {
      const source = sharp(file.buffer, {
        limitInputPixels: 40000000,
        animated: false,
        failOn: 'warning',
      });
      const metadata = await source.metadata();
      if (
        !['jpeg', 'png', 'webp', 'heif'].includes(metadata.format ?? '') ||
        (metadata.pages ?? 1) > 1
      )
        throw new Error('Unsupported image');
      result = await source
        .rotate()
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      if (result.data.length > 3145728) throw new Error('Normalized image too large');
    } catch {
      throw new BadRequestException('Image is invalid or too large to process');
    }
    const checksum = hash(result.data);
    return this.mutate(
      number,
      version,
      admin,
      'PHOTO',
      'Private intake photo added',
      async (job, session) => {
        this.requireOpen(job);
        if (job.photoCount >= 8)
          throw new ConflictException('A job can hold up to 8 intake photos');
        if (await this.photos.exists({ jobId: job._id, checksum }).session(session))
          throw new ConflictException('This photo is already attached');
        await this.photos.create(
          [
            {
              jobId: job._id,
              checksum,
              bytes: result.data,
              sizeBytes: result.data.length,
              width: result.info.width,
              height: result.info.height,
              uploadedBy: new Types.ObjectId(admin.id),
            },
          ],
          { session },
        );
        job.photoCount += 1;
      },
    );
  }
  async photo(number: string, id: string, admin: AuthenticatedAdmin): Promise<Buffer> {
    const job = await this.find(number, admin);
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Photo not found');
    const photo = await this.photos.findOne({ _id: id, jobId: job._id }).select('+bytes');
    if (!photo) throw new NotFoundException('Photo not found');
    return photo.bytes;
  }
  async removePhoto(
    number: string,
    id: string,
    version: number,
    admin: AuthenticatedAdmin,
  ): Promise<RepairJobView> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Photo not found');
    return this.mutate(
      number,
      version,
      admin,
      'PHOTO_REMOVED',
      'Private photo removed',
      async (job, session) => {
        this.requireOpen(job);
        const result = await this.photos.deleteOne({ _id: id, jobId: job._id }, { session });
        if (!result.deletedCount) throw new NotFoundException('Photo not found');
        job.photoCount -= 1;
      },
    );
  }

  async team(admin: AuthenticatedAdmin): Promise<RepairTeamMember[]> {
    this.requireManage(admin);
    const owner = admin.roles.includes(AdminRole.Owner);
    const rows = await this.users
      .find(
        owner
          ? { roles: { $in: [AdminRole.Reception, AdminRole.Technician] } }
          : { roles: AdminRole.Technician, status: AccountStatus.Active },
      )
      .sort({ name: 1 })
      .limit(200);
    return rows.map((user) => ({
      id: user.id,
      name: user.name,
      ...(owner ? { email: user.email } : {}),
      roles: user.roles,
      status: user.status,
      version: user.get('version') as number,
    }));
  }
  async createMember(input: CreateRepairMemberDto, admin: AuthenticatedAdmin): Promise<void> {
    this.requireOwner(admin);
    const passwordHash = await this.passwords.hash(input.password);
    try {
      await this.connection.transaction(async (session) => {
        const [user] = await this.users.create(
          [
            {
              name: input.name,
              email: input.email.toLowerCase(),
              passwordHash,
              roles: [input.role === 'TECHNICIAN' ? AdminRole.Technician : AdminRole.Reception],
              status: AccountStatus.Active,
            },
          ],
          { session },
        );
        await this.audit.record(
          {
            action: 'REPAIR_TEAM_CREATED',
            resourceType: 'ADMIN_USER',
            resourceId: user.id,
            actorId: admin.id,
            metadata: { role: input.role },
          },
          session,
        );
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictException('An account with this email already exists');
      throw error;
    }
  }
  async memberStatus(
    id: string,
    input: RepairMemberStatusDto,
    admin: AuthenticatedAdmin,
  ): Promise<void> {
    this.requireOwner(admin);
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Team member not found');
    await this.connection.transaction(async (session) => {
      const user = await this.users.findOneAndUpdate(
        {
          _id: id,
          version: input.expectedVersion,
          roles: {
            $in: [AdminRole.Reception, AdminRole.Technician],
            $nin: [AdminRole.Owner, AdminRole.Staff],
          },
        },
        { $set: { status: input.status }, $inc: { version: 1 } },
        { session, returnDocument: 'after', runValidators: true },
      );
      if (!user) throw new ConflictException('Team member changed or is not managed here');
      if (input.status === 'DISABLED')
        await this.connection
          .model<AdminSession>(AdminSession.name)
          .updateMany(
            { adminUserId: user._id, revokedAt: { $exists: false } },
            { $set: { revokedAt: new Date() } },
            { session },
          );
      await this.audit.record(
        {
          action: 'REPAIR_TEAM_STATUS',
          resourceType: 'ADMIN_USER',
          resourceId: user.id,
          actorId: admin.id,
          metadata: { status: input.status },
        },
        session,
      );
    });
  }

  private async mutate(
    number: string,
    version: number,
    admin: AuthenticatedAdmin,
    action: string,
    reason: string,
    change: (job: RepairJobDocument, session: ClientSession) => void | Promise<void>,
  ): Promise<RepairJobView> {
    const updated = await this.connection.transaction(async (session) => {
      const job = await this.find(number, admin, session);
      if (job.get('version') !== version) this.changed();
      if (job.history.length >= 1000) throw new ConflictException('Job history limit reached');
      await change(job, session);
      job.history.push(this.event(admin, action, job.status, reason));
      await job.save({ session });
      await this.record(job, admin, action, session);
      return job;
    });
    return this.view(updated, admin);
  }
  private async find(
    number: string,
    admin: AuthenticatedAdmin,
    session?: ClientSession,
  ): Promise<RepairJobDocument> {
    const job = await this.jobs
      .findOne({
        number,
        ...(canManageJobs(admin) ? {} : { technicianId: new Types.ObjectId(admin.id) }),
      })
      .session(session ?? null);
    if (!job) throw new NotFoundException('Job not found or unavailable');
    return job;
  }
  private async view(
    job: RepairJobDocument,
    admin: AuthenticatedAdmin,
    details = true,
  ): Promise<RepairJobView> {
    const manage = canManageJobs(admin);
    const photos = details ? await this.photos.find({ jobId: job._id }).sort({ createdAt: 1 }) : [];
    return {
      number: job.number,
      bookingReference: job.bookingReference,
      billingInvoiceNumber:
        manage && details ? await this.billing.invoiceReference(job._id) : undefined,
      warrantySourceJobNumber: job.warrantySourceJobNumber,
      warrantySourceInvoiceNumber: job.warrantySourceInvoiceNumber,
      version: job.get('version') as number,
      customerName: job.customerName,
      ...(manage ? { phone: job.phone, email: job.email } : {}),
      deviceLabel: job.deviceLabel,
      imei: job.imei,
      serial: job.serial,
      issue: job.issue,
      condition: job.condition,
      accessories: job.accessories,
      targetAt: job.targetAt,
      technicianId: job.technicianId?.toHexString(),
      technicianName: job.technicianName,
      status: job.status,
      custody: job.custody,
      returnedAt: job.returnedAt,
      returnedTo: job.returnedTo,
      diagnosis: job.diagnosis,
      createdAt: job.get('createdAt') as Date,
      estimates: details
        ? job.estimates.map((estimate) => ({
            revision: estimate.revision,
            lines: estimate.lines.map((line) => ({
              description: line.description,
              quantity: line.quantity,
              unitPriceInPaise: line.unitPriceInPaise,
            })),
            totalInPaise: estimate.totalInPaise,
            reason: estimate.reason,
            at: estimate.at,
            approval: estimate.approval
              ? {
                  decision: estimate.approval.decision,
                  method: estimate.approval.method,
                  customerName: estimate.approval.customerName,
                  evidence: estimate.approval.evidence,
                  at: estimate.approval.at,
                }
              : undefined,
          }))
        : [],
      tests: job.tests.map((test) => ({ key: test.key, result: test.result, notes: test.notes })),
      history: details
        ? job.history
            .filter((event) => manage || event.action !== 'BILLING')
            .map((event) => ({
              at: event.at,
              actorName: event.actorName,
              action: event.action,
              status: event.status,
              reason: event.reason,
            }))
        : [],
      photos: photos.map((photo) => ({
        id: photo.id,
        width: photo.width,
        height: photo.height,
        createdAt: photo.get('createdAt') as Date,
        url: `admin/repair/jobs/${job.number}/photos/${photo.id}`,
      })),
      permissions: { manage, repair: this.canRepair(job, admin) },
    };
  }
  private canRepair(job: RepairJobDocument, admin: AuthenticatedAdmin): boolean {
    return (
      admin.roles.some((role) => [AdminRole.Owner, AdminRole.Staff].includes(role)) ||
      (admin.roles.includes(AdminRole.Technician) && job.technicianId?.toHexString() === admin.id)
    );
  }
  private requireRepair(job: RepairJobDocument, admin: AuthenticatedAdmin): void {
    if (!this.canRepair(job, admin))
      throw new ForbiddenException(
        'Only the assigned technician or owner/staff can perform repair work',
      );
  }
  private requireManage(admin: AuthenticatedAdmin): void {
    if (!canManageJobs(admin))
      throw new ForbiddenException('Reception or owner/staff access is required');
  }
  private requireOwner(admin: AuthenticatedAdmin): void {
    if (!admin.roles.includes(AdminRole.Owner))
      throw new ForbiddenException('Only the owner can manage repair accounts');
  }
  private requireOpen(job: RepairJobDocument): void {
    if (terminal.includes(job.status)) throw new ConflictException('This repair outcome is closed');
  }
  private changed(): never {
    throw new ConflictException('This job changed. Refresh before trying again.');
  }
  private event(
    admin: AuthenticatedAdmin,
    action: string,
    status: Status,
    reason: string,
  ): RepairJobEvent {
    return {
      at: new Date(),
      actorId: new Types.ObjectId(admin.id),
      actorName: admin.name,
      action,
      status,
      reason,
    };
  }
  private async record(
    job: RepairJobDocument,
    admin: AuthenticatedAdmin,
    action: string,
    session: ClientSession,
  ): Promise<void> {
    await this.audit.record(
      {
        action: `REPAIR_JOB_${action}`,
        resourceType: 'REPAIR_JOB',
        resourceId: job.id,
        actorId: admin.id,
        metadata: { number: job.number, status: job.status, version: job.get('version') as number },
      },
      session,
    );
  }
}
