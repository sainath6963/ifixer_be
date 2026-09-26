import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, HydratedDocument, Model, Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { createHash, randomBytes } from 'node:crypto';
import {
  RepairBillingSettings,
  RepairBillingOperation,
  RepairBillingSequence,
  RepairInvoice,
  RepairMoneyEntry,
  RepairWarranty,
  BillingIssuer,
} from '../../database/schemas/repair-billing.schema';
import {
  RepairJob,
  RepairJobDocument,
  RepairJobStatus as Status,
} from '../../database/schemas/repair-job.schema';
import { AdminRole } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import type {
  BillingOperationDto,
  BillingSettingsDto,
  IssueInvoiceDto,
  MoneyDto,
  RefundDto,
  CreditDto,
  DeliveryCreditDto,
  WarrantyFollowupDto,
  InvoiceQueryDto,
  BillingJobDto,
} from './repair-billing.dto';
import { invoiceAmounts } from './billing-math';
export type BillingView = Record<string, unknown>;
const version = (doc: HydratedDocument<unknown>): number => doc.get('version') as number;
const owner = (admin: AuthenticatedAdmin): boolean => admin.roles.includes(AdminRole.Owner);
const closed = (job: RepairJob): boolean =>
  [Status.Cancelled, Status.Unrepairable, Status.Delivered].includes(job.status);
const issuerView = (issuer: BillingIssuer): BillingIssuer => ({
  name: issuer.name,
  address: issuer.address,
  phone: issuer.phone,
  taxId: issuer.taxId,
});
function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return input;
}
@Injectable()
export class RepairBillingService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(RepairBillingSettings.name)
    private readonly settings: Model<RepairBillingSettings>,
    @InjectModel(RepairInvoice.name) private readonly invoices: Model<RepairInvoice>,
    @InjectModel(RepairMoneyEntry.name) private readonly entries: Model<RepairMoneyEntry>,
    @InjectModel(RepairWarranty.name) private readonly warranties: Model<RepairWarranty>,
    @InjectModel(RepairBillingOperation.name)
    private readonly operations: Model<RepairBillingOperation>,
    @InjectModel(RepairBillingSequence.name)
    private readonly sequences: Model<RepairBillingSequence>,
    @InjectModel(RepairJob.name) private readonly jobs: Model<RepairJob>,
    private readonly audit: AuthAuditService,
  ) {}
  async getSettings(): Promise<BillingView> {
    const row = await this.settings.findOne({ key: 'SHOP' });
    return row
      ? {
          configured: true,
          version: version(row),
          issuer: issuerView(row.issuer),
          taxes: row.taxes.map((tax) => ({ label: tax.label, rateBps: tax.rateBps })),
          warrantyDays: row.warrantyDays,
          warrantyCoverage: row.warrantyCoverage,
          warrantyExclusions: row.warrantyExclusions,
          invoiceNote: row.invoiceNote,
        }
      : { configured: false, version: -1 };
  }
  async saveSettings(input: BillingSettingsDto, admin: AuthenticatedAdmin): Promise<BillingView> {
    this.requireOwner(admin);
    if (
      new Set(input.taxes.map((tax) => tax.label.toLowerCase())).size !== input.taxes.length ||
      input.taxes.reduce((sum, tax) => sum + tax.rateBps, 0) > 10000
    )
      throw new BadRequestException('Use unique tax labels with combined rate at most 100%');
    await this.operation('SETTINGS', input, admin, async (session) => {
      let row = await this.settings.findOne({ key: 'SHOP' }).session(session);
      if ((row ? version(row) : -1) !== input.expectedVersion) this.changed();
      const fields = {
        issuer: input.issuer,
        taxes: input.taxes,
        warrantyDays: input.warrantyDays,
        warrantyCoverage: input.warrantyCoverage,
        warrantyExclusions: input.warrantyExclusions,
        invoiceNote: input.invoiceNote,
      };
      if (row) Object.assign(row, fields);
      else row = new this.settings({ key: 'SHOP', ...fields });
      await row.save({ session });
      await this.record(admin, 'BILLING_SETTINGS', row.id, session);
      return row.id;
    });
    return this.getSettings();
  }
  async get(number: string, admin: AuthenticatedAdmin): Promise<BillingView> {
    this.requireManage(admin);
    const job = await this.findJob(number);
    const invoice = await this.invoices.findOne({ jobId: job._id });
    const entries = await this.entries.find({ jobId: job._id }).sort({ createdAt: 1, _id: 1 });
    const warranty = await this.warranties.findOne({ jobId: job._id });
    const followups = await this.jobs
      .find({ warrantySourceJobNumber: job.number })
      .select('number status createdAt')
      .sort({ createdAt: -1 });
    return {
      jobNumber: job.number,
      jobVersion: version(job),
      invoice: invoice ? this.invoiceView(invoice) : null,
      entries: entries.map((entry) => this.entryView(entry)),
      summary: this.summary(invoice, entries, closed(job)),
      warranty: warranty
        ? {
            days: warranty.days,
            startsAt: warranty.startsAt,
            endsAt: warranty.endsAt,
            active:
              warranty.days > 0 &&
              !!warranty.startsAt &&
              !!warranty.endsAt &&
              warranty.endsAt > new Date(),
          }
        : null,
      deliveryAuthorization: job.billingAuthorization
        ? {
            invoiceNumber: job.billingAuthorization.invoiceNumber,
            dueInPaise: job.billingAuthorization.dueInPaise,
            reason: job.billingAuthorization.reason,
            authorizedByName: job.billingAuthorization.authorizedByName,
            at: job.billingAuthorization.at,
          }
        : null,
      sourceJobNumber: job.warrantySourceJobNumber,
      sourceInvoiceNumber: job.warrantySourceInvoiceNumber,
      followups: followups.map((child) => ({
        number: child.number,
        status: child.status,
        createdAt: child.get('createdAt') as Date,
      })),
      permissions: { owner: owner(admin) },
    };
  }
  async list(query: InvoiceQueryDto, admin: AuthenticatedAdmin): Promise<BillingView> {
    this.requireManage(admin);
    const search = query.search?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = search
      ? {
          $or: ['number', 'jobNumber', 'customerName', 'phone'].map((key) => ({
            [key]: { $regex: search, $options: 'i' },
          })),
        }
      : {};
    const [rows, total] = await Promise.all([
      this.invoices
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.invoices.countDocuments(filter),
    ]);
    return {
      items: await Promise.all(
        rows.map(async (row): Promise<BillingView> => ({
          ...this.invoiceView(row),
          summary: this.summary(row, await this.entries.find({ jobId: row.jobId }), false),
        })),
      ),
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }
  async issue(
    number: string,
    input: IssueInvoiceDto,
    admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    this.requireManage(admin);
    await this.jobOperation(number, 'ISSUE', input, admin, async (job, session) => {
      if (job.status === Status.Delivered)
        throw new ConflictException('A delivered job cannot be invoiced retrospectively here');
      await this.assertEstimateOpen(job, session);
      const estimate = job.estimates.at(-1);
      if (
        !estimate ||
        estimate.revision !== input.estimateRevision ||
        estimate.approval?.decision !== 'APPROVED'
      )
        throw new ConflictException('The latest estimate must be approved before invoicing');
      const settings = await this.requireSettings(session);
      if (version(settings) !== input.expectedSettingsVersion) this.changed();
      if (
        !owner(admin) &&
        (input.warrantyDays !== settings.warrantyDays ||
          input.warrantyCoverage !== settings.warrantyCoverage ||
          input.warrantyExclusions !== settings.warrantyExclusions ||
          input.applyTax !== settings.taxes.length > 0)
      )
        throw new ForbiddenException(
          'Only the owner can override configured tax or warranty terms for an invoice',
        );
      const totals = invoiceAmounts(
        input.lines,
        input.discountInPaise,
        input.applyTax ? settings.taxes : [],
      );
      if (totals.totalInPaise !== input.expectedTotalInPaise)
        throw new ConflictException('Invoice preview changed. Review the total again.');
      if (totals.totalInPaise > estimate.totalInPaise)
        throw new ConflictException(
          'Final total exceeds the approved estimate. Obtain approval of a revised estimate first.',
        );
      const invoice = await new this.invoices({
        number: await this.nextNumber('INV', session),
        jobId: job._id,
        jobNumber: job.number,
        issuer: issuerView(settings.issuer),
        customerName: job.customerName,
        phone: job.phone,
        deviceLabel: job.deviceLabel,
        imei: job.imei,
        serial: job.serial,
        estimateRevision: estimate.revision,
        lines: input.lines,
        ...totals,
        warrantyDays: input.warrantyDays,
        warrantyCoverage: input.warrantyCoverage,
        warrantyExclusions: input.warrantyExclusions,
        note: settings.invoiceNote,
        issuedBy: admin.id,
        issuedByName: admin.name,
      }).save({ session });
      await new this.warranties({
        jobId: job._id,
        invoiceId: invoice._id,
        days: invoice.warrantyDays,
      }).save({ session });
      job.billingAuthorization = undefined;
      return `Invoice ${invoice.number} issued. ${input.reason}`;
    });
    return this.get(number, admin);
  }
  async payment(number: string, input: MoneyDto, admin: AuthenticatedAdmin): Promise<BillingView> {
    this.requireManage(admin);
    this.checkMethod(input);
    await this.jobOperation(number, 'PAYMENT', input, admin, async (job, session) => {
      const { invoice, entries } = await this.balance(job, session);
      const totals = this.summary(invoice, entries, closed(job));
      if (!invoice && closed(job))
        throw new ConflictException('Closed jobs require an invoice before accepting payment');
      if (input.amountInPaise > (invoice ? totals.dueInPaise : 1000000000 - totals.netPaidInPaise))
        throw new ConflictException('Payment exceeds the amount due or advance limit');
      await this.addEntry(job, 'PAYMENT', input, admin, session, invoice);
      job.billingAuthorization = undefined;
      return `${input.method} payment recorded manually: ${input.amountInPaise} paise. ${input.reason}`;
    });
    return this.get(number, admin);
  }
  async refund(number: string, input: RefundDto, admin: AuthenticatedAdmin): Promise<BillingView> {
    this.requireOwner(admin);
    this.checkMethod(input);
    await this.jobOperation(number, 'REFUND', input, admin, async (job, session) => {
      const { invoice, entries } = await this.balance(job, session);
      const payment = entries.find(
        (entry) => entry.id === input.paymentId && entry.kind === 'PAYMENT',
      );
      if (!payment) throw new BadRequestException('Choose a payment from this job');
      const already = entries
        .filter((entry) => entry.kind === 'REFUND' && entry.paymentId?.equals(payment._id))
        .reduce((sum, entry) => sum + entry.amountInPaise, 0);
      if (input.amountInPaise > payment.amountInPaise - already)
        throw new ConflictException('Refund exceeds the unrefunded payment amount');
      await this.addEntry(job, 'REFUND', input, admin, session, invoice, payment._id);
      job.billingAuthorization = undefined;
      return `Refund recorded manually: ${input.amountInPaise} paise. ${input.reason}`;
    });
    return this.get(number, admin);
  }
  async credit(number: string, input: CreditDto, admin: AuthenticatedAdmin): Promise<BillingView> {
    this.requireOwner(admin);
    await this.jobOperation(number, 'CREDIT', input, admin, async (job, session) => {
      const { invoice, entries } = await this.balance(job, session);
      if (!invoice) throw new ConflictException('Issue an invoice before crediting a charge');
      if (input.amountInPaise > this.summary(invoice, entries, closed(job)).chargeInPaise)
        throw new ConflictException('Credit exceeds remaining invoice charges');
      await this.addEntry(job, 'CREDIT', input, admin, session, invoice);
      job.billingAuthorization = undefined;
      return `Credit note recorded: ${input.amountInPaise} paise. ${input.reason}`;
    });
    return this.get(number, admin);
  }
  async authorize(
    number: string,
    input: DeliveryCreditDto,
    admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    this.requireOwner(admin);
    await this.jobOperation(number, 'DELIVERY_CREDIT', input, admin, async (job, session) => {
      if (job.custody !== 'IN_SHOP')
        throw new ConflictException('Device has already been returned');
      const { invoice, entries } = await this.balance(job, session);
      const totals = this.summary(invoice, entries, closed(job));
      if (!invoice || totals.dueInPaise !== input.expectedDueInPaise || totals.refundDueInPaise > 0)
        this.changed();
      if (input.allow && totals.dueInPaise === 0)
        throw new BadRequestException('There is no unpaid balance to authorize');
      job.billingAuthorization = input.allow
        ? {
            invoiceNumber: invoice.number,
            dueInPaise: totals.dueInPaise,
            authorizedBy: new Types.ObjectId(admin.id),
            authorizedByName: admin.name,
            at: new Date(),
            reason: input.reason,
          }
        : undefined;
      return `${input.allow ? 'Authorized' : 'Revoked'} delivery with balance due. ${input.reason}`;
    });
    return this.get(number, admin);
  }
  async followup(
    number: string,
    input: WarrantyFollowupDto,
    admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    this.requireManage(admin);
    await this.jobOperation(number, 'WARRANTY_FOLLOWUP', input, admin, async (job, session) => {
      const invoice = await this.invoices.findOne({ jobId: job._id }).session(session);
      const warranty = await this.warranties.findOne({ jobId: job._id }).session(session);
      if (!invoice || !warranty?.startsAt || job.status !== Status.Delivered)
        throw new ConflictException(
          'A warranty follow-up must reference a delivered, invoiced repair',
        );
      const childNumber = `JOB-${randomBytes(8).toString('hex').toUpperCase()}`;
      await new this.jobs({
        number: childNumber,
        operationKey: `billing:${admin.id}:${input.idempotencyKey}`,
        requestHash: createHash('sha256')
          .update(JSON.stringify(canonical(input)))
          .digest('hex'),
        customerId: job.customerId,
        modelId: job.modelId,
        customerName: job.customerName,
        phone: job.phone,
        email: job.email,
        deviceLabel: job.deviceLabel,
        imei: job.imei,
        serial: job.serial,
        issue: input.issue,
        condition: input.condition,
        accessories: input.accessories,
        warrantySourceJobNumber: job.number,
        warrantySourceInvoiceNumber: invoice.number,
        history: [
          {
            at: new Date(),
            actorId: new Types.ObjectId(admin.id),
            actorName: admin.name,
            action: 'INTAKE',
            status: Status.Received,
            reason: `Warranty follow-up for ${job.number} / ${invoice.number}. Coverage requires inspection; no free repair is automatically approved.`,
          },
        ],
      }).save({ session });
      return `Warranty follow-up ${childNumber} opened for invoice ${invoice.number}`;
    });
    return this.get(number, admin);
  }
  async invoiceReference(jobId: Types.ObjectId): Promise<string | undefined> {
    return (await this.invoices.findOne({ jobId }).select('number'))?.number;
  }
  async assertEstimateOpen(job: RepairJobDocument, session: ClientSession): Promise<void> {
    if (await this.invoices.exists({ jobId: job._id }).session(session))
      throw new ConflictException(
        'An issued invoice is immutable. Use a credit note for charge reductions; new work needs a new job.',
      );
  }
  async assertHandover(
    job: RepairJobDocument,
    session: ClientSession,
    delivery: boolean,
  ): Promise<void> {
    const { invoice, entries } = await this.balance(job, session);
    const totals = this.summary(invoice, entries, true);
    if (!invoice) {
      if (delivery) throw new ConflictException('Issue the repair invoice before delivery');
      if (totals.netPaidInPaise > 0)
        throw new ConflictException(
          'Refund the remaining advance before returning this closed job',
        );
      return;
    }
    if (totals.refundDueInPaise > 0)
      throw new ConflictException('Record the outstanding customer refund before handover');
    const approval = job.billingAuthorization;
    if (
      totals.dueInPaise > 0 &&
      (!approval ||
        approval.invoiceNumber !== invoice.number ||
        approval.dueInPaise < totals.dueInPaise)
    )
      throw new ConflictException(
        'Collect the balance or ask the owner to authorize delivery with this balance due',
      );
    if (delivery) {
      const at = new Date();
      await this.warranties.updateOne(
        { jobId: job._id, startsAt: { $exists: false } },
        {
          $set: { startsAt: at, endsAt: new Date(at.getTime() + invoice.warrantyDays * 86400000) },
          $inc: { version: 1 },
        },
        { session, runValidators: true },
      );
    }
  }
  private summary(
    invoice: RepairInvoice | null,
    entries: RepairMoneyEntry[],
    terminal: boolean,
  ): {
    receivedInPaise: number;
    refundedInPaise: number;
    netPaidInPaise: number;
    creditedInPaise: number;
    chargeInPaise: number;
    dueInPaise: number;
    refundDueInPaise: number;
    advanceInPaise: number;
  } {
    const sum = (kind: string): number =>
      entries
        .filter((entry) => entry.kind === kind)
        .reduce((total, entry) => total + entry.amountInPaise, 0);
    const received = sum('PAYMENT');
    const refunded = sum('REFUND');
    const net = received - refunded;
    const credited = sum('CREDIT');
    const charge = (invoice?.totalInPaise ?? 0) - credited;
    return {
      receivedInPaise: received,
      refundedInPaise: refunded,
      netPaidInPaise: net,
      creditedInPaise: credited,
      chargeInPaise: charge,
      dueInPaise: invoice ? Math.max(0, charge - net) : 0,
      refundDueInPaise: invoice || terminal ? Math.max(0, net - charge) : 0,
      advanceInPaise: invoice ? 0 : net,
    };
  }
  private async balance(
    job: RepairJobDocument,
    session: ClientSession,
  ): Promise<{
    invoice: HydratedDocument<RepairInvoice> | null;
    entries: HydratedDocument<RepairMoneyEntry>[];
  }> {
    const invoice = await this.invoices.findOne({ jobId: job._id }).session(session);
    const entries = await this.entries.find({ jobId: job._id }).session(session);
    return { invoice, entries };
  }
  private async addEntry(
    job: RepairJobDocument,
    kind: string,
    input: MoneyDto | CreditDto,
    admin: AuthenticatedAdmin,
    session: ClientSession,
    invoice: HydratedDocument<RepairInvoice> | null,
    paymentId?: Types.ObjectId,
  ): Promise<void> {
    if ((await this.entries.countDocuments({ jobId: job._id }).session(session)) >= 500)
      throw new ConflictException('Financial entry limit reached for this job');
    const settings = await this.requireSettings(session);
    await new this.entries({
      number: await this.nextNumber(
        kind === 'PAYMENT' ? 'RCP' : kind === 'REFUND' ? 'REF' : 'CRN',
        session,
      ),
      jobId: job._id,
      jobNumber: job.number,
      kind,
      amountInPaise: input.amountInPaise,
      method: 'method' in input ? input.method : undefined,
      reference: 'reference' in input ? input.reference : undefined,
      paymentId,
      invoiceId: invoice?._id,
      invoiceNumber: invoice?.number,
      paymentNumber: paymentId
        ? (await this.entries.findById(paymentId).select('number').session(session))?.number
        : undefined,
      issuer: issuerView(settings.issuer),
      customerName: job.customerName,
      reason: input.reason,
      recordedBy: admin.id,
      recordedByName: admin.name,
    }).save({ session });
  }
  private checkMethod(input: MoneyDto): void {
    if (input.method === 'UPI' && !input.reference)
      throw new BadRequestException(
        'Record the UPI transaction reference after checking the actual payment',
      );
  }
  private async requireSettings(
    session: ClientSession,
  ): Promise<HydratedDocument<RepairBillingSettings>> {
    const settings = await this.settings.findOne({ key: 'SHOP' }).session(session);
    if (!settings)
      throw new ConflictException(
        'The owner must configure billing identity, tax and warranty settings first',
      );
    return settings;
  }
  private async nextNumber(key: string, session: ClientSession): Promise<string> {
    const row = await this.sequences
      .findOneAndUpdate(
        { key },
        { $inc: { value: 1, version: 1 } },
        { session, upsert: true, returnDocument: 'after', setDefaultsOnInsert: false },
      )
      .orFail();
    if (row.value > 999999999) throw new ConflictException('Document numbering limit reached');
    return `${key}-${String(row.value).padStart(6, '0')}`;
  }
  private async findJob(number: string, session?: ClientSession): Promise<RepairJobDocument> {
    const job = await this.jobs.findOne({ number }).session(session ?? null);
    if (!job) throw new NotFoundException('Repair job not found');
    return job;
  }
  private async jobOperation(
    number: string,
    kind: string,
    input: BillingJobDto,
    admin: AuthenticatedAdmin,
    work: (job: RepairJobDocument, session: ClientSession) => Promise<string>,
  ): Promise<void> {
    await this.findJob(number);
    await this.operation(`${kind}:${number}`, input, admin, async (session) => {
      const job = await this.findJob(number, session);
      if (version(job) !== input.expectedJobVersion) this.changed();
      if (job.history.length >= 1000) throw new ConflictException('Job history limit reached');
      const reason = await work(job, session);
      job.history.push({
        at: new Date(),
        actorId: new Types.ObjectId(admin.id),
        actorName: admin.name,
        action: 'BILLING',
        status: job.status,
        reason,
      });
      await job.save({ session });
      await this.record(admin, `REPAIR_${kind}`, job.id, session);
      return job.number;
    });
  }
  private async operation(
    kind: string,
    input: BillingOperationDto,
    admin: AuthenticatedAdmin,
    work: (session: ClientSession) => Promise<string>,
  ): Promise<string> {
    const key = `${admin.id}:${input.idempotencyKey}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(canonical({ kind, input })))
      .digest('hex');
    const replay = async (session?: ClientSession): Promise<string | undefined> => {
      const row = await this.operations.findOne({ key }).session(session ?? null);
      if (row && row.requestHash !== requestHash)
        throw new ConflictException('This operation key was used for different billing details');
      return row?.result;
    };
    const prior = await replay();
    if (prior) return prior;
    try {
      return await this.connection.transaction(async (session) => {
        const found = await replay(session);
        if (found) return found;
        const result = await work(session);
        await new this.operations({ key, kind, requestHash, result, actorId: admin.id }).save({
          session,
        });
        return result;
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const found = await replay();
        if (found) return found;
        throw new ConflictException(
          'This document, operation or UPI transaction reference already exists',
        );
      }
      throw error;
    }
  }
  private invoiceView(row: HydratedDocument<RepairInvoice>): BillingView {
    return {
      id: row.id,
      number: row.number,
      jobNumber: row.jobNumber,
      issuer: issuerView(row.issuer),
      customerName: row.customerName,
      phone: row.phone,
      deviceLabel: row.deviceLabel,
      imei: row.imei,
      serial: row.serial,
      estimateRevision: row.estimateRevision,
      lines: row.lines.map((line) => ({
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitPriceInPaise: line.unitPriceInPaise,
      })),
      subtotalInPaise: row.subtotalInPaise,
      discountInPaise: row.discountInPaise,
      taxableInPaise: row.taxableInPaise,
      taxes: row.taxes.map((tax) => ({
        label: tax.label,
        rateBps: tax.rateBps,
        amountInPaise: tax.amountInPaise,
      })),
      totalInPaise: row.totalInPaise,
      warrantyDays: row.warrantyDays,
      warrantyCoverage: row.warrantyCoverage,
      warrantyExclusions: row.warrantyExclusions,
      note: row.note,
      issuedByName: row.issuedByName,
      issuedAt: row.get('createdAt') as Date,
    };
  }
  private entryView(row: HydratedDocument<RepairMoneyEntry>): BillingView {
    return {
      id: row.id,
      number: row.number,
      jobNumber: row.jobNumber,
      kind: row.kind,
      amountInPaise: row.amountInPaise,
      method: row.method,
      reference: row.reference,
      paymentId: row.paymentId?.toHexString(),
      paymentNumber: row.paymentNumber,
      invoiceNumber: row.invoiceNumber,
      reason: row.reason,
      issuer: issuerView(row.issuer),
      customerName: row.customerName,
      recordedByName: row.recordedByName,
      recordedAt: row.get('createdAt') as Date,
      verification: row.kind === 'CREDIT' ? undefined : 'STAFF_RECORDED',
    };
  }
  private async record(
    admin: AuthenticatedAdmin,
    action: string,
    resourceId: string,
    session: ClientSession,
  ): Promise<void> {
    await this.audit.record(
      { action, resourceType: 'REPAIR_BILLING', resourceId, actorId: admin.id },
      session,
    );
  }
  private requireManage(admin: AuthenticatedAdmin): void {
    if (
      !admin.roles.some((role) =>
        [AdminRole.Owner, AdminRole.Staff, AdminRole.Reception].includes(role),
      )
    )
      throw new ForbiddenException('Billing is restricted to the owner, staff and reception');
  }
  private requireOwner(admin: AuthenticatedAdmin): void {
    if (!owner(admin)) throw new ForbiddenException('Owner permission is required');
  }
  private changed(): never {
    throw new ConflictException(
      'Billing, settings or job details changed. Refresh before trying again.',
    );
  }
}
