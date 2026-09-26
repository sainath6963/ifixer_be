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
import { Product } from '../../database/schemas/catalog.schema';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
} from '../../database/schemas/inventory.schema';
import {
  RepairCostAllocation,
  RepairGoodsReceipt,
  RepairPartUsage,
  RepairPurchase,
  RepairStockLot,
  RepairStockOperation,
  RepairSupplier,
  SparePartProfile,
} from '../../database/schemas/repair-inventory.schema';
import { DeviceModel, DeviceBrand } from '../../database/schemas/repair.schema';
import {
  RepairJob,
  RepairJobDocument,
  RepairJobStatus,
} from '../../database/schemas/repair-job.schema';
import {
  AdminRole,
  InventoryMovementType,
  InventoryReservationStatus,
  ProductStatus,
} from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import type {
  InventoryQueryDto,
  JobPartActionDto,
  PurchaseCancelDto,
  PurchaseDto,
  ReceiptDto,
  ReservePartDto,
  SparePartDto,
  StockAdjustmentDto,
  StockOperationDto,
  SupplierDto,
} from './repair-inventory.dto';

export type InventoryView = Record<string, unknown>;
export interface InventoryPage {
  items: InventoryView[];
  page: number;
  total: number;
  totalPages: number;
}
export const managesStock = (admin: AuthenticatedAdmin): boolean =>
  admin.roles.some((role) => [AdminRole.Owner, AdminRole.Staff].includes(role));
const id = (value: string): Types.ObjectId => {
  if (!Types.ObjectId.isValid(value)) throw new NotFoundException('Record not found');
  return new Types.ObjectId(value);
};
const version = (doc: { get(path: string): unknown }): number => doc.get('version') as number;
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

@Injectable()
export class RepairInventoryService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(SparePartProfile.name) private readonly parts: Model<SparePartProfile>,
    @InjectModel(RepairSupplier.name) private readonly suppliers: Model<RepairSupplier>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(InventoryLevel.name) private readonly levels: Model<InventoryLevel>,
    @InjectModel(InventoryMovement.name) private readonly movements: Model<InventoryMovement>,
    @InjectModel(InventoryReservation.name)
    private readonly reservations: Model<InventoryReservation>,
    @InjectModel(RepairStockLot.name) private readonly lots: Model<RepairStockLot>,
    @InjectModel(RepairPurchase.name) private readonly purchases: Model<RepairPurchase>,
    @InjectModel(RepairGoodsReceipt.name) private readonly receipts: Model<RepairGoodsReceipt>,
    @InjectModel(RepairPartUsage.name) private readonly usages: Model<RepairPartUsage>,
    @InjectModel(RepairStockOperation.name)
    private readonly operations: Model<RepairStockOperation>,
    @InjectModel(RepairJob.name) private readonly jobs: Model<RepairJob>,
    @InjectModel(DeviceModel.name) private readonly models: Model<DeviceModel>,
    @InjectModel(DeviceBrand.name) private readonly brands: Model<DeviceBrand>,
    private readonly audit: AuthAuditService,
  ) {}

  async saveSupplier(
    input: SupplierDto,
    admin: AuthenticatedAdmin,
    supplierId?: string,
  ): Promise<InventoryView> {
    this.requireManager(admin);
    const resultId = await this.operation(
      `SUPPLIER:${supplierId ?? 'new'}`,
      input,
      admin,
      async (session) => {
        const fields = {
          name: input.name,
          code: input.code,
          contactName: input.contactName,
          phone: input.phone,
          email: input.email,
          address: input.address,
          active: input.active,
        };
        const supplier = supplierId
          ? await this.suppliers.findById(id(supplierId)).session(session)
          : new this.suppliers(fields);
        if (!supplier) throw new NotFoundException('Supplier not found');
        if (supplierId && version(supplier) !== input.expectedVersion) this.changed();
        Object.assign(supplier, fields);
        await supplier.save({ session });
        await this.auditEvent(admin, 'SUPPLIER_SAVED', supplier.id, session);
        return supplier.id;
      },
    );
    return this.supplierView(await this.suppliers.findById(resultId).orFail());
  }
  async listSuppliers(query: InventoryQueryDto, admin: AuthenticatedAdmin): Promise<InventoryPage> {
    this.requireManager(admin);
    const filter = query.search
      ? {
          $or: ['name', 'code', 'contactName'].map((key) => ({
            [key]: { $regex: escape(query.search ?? ''), $options: 'i' },
          })),
        }
      : {};
    const [rows, total] = await Promise.all([
      this.suppliers
        .find(filter)
        .sort({ name: 1, _id: 1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.suppliers.countDocuments(filter),
    ]);
    return this.page(
      rows.map((row) => this.supplierView(row)),
      total,
      query,
    );
  }
  async savePart(
    input: SparePartDto,
    admin: AuthenticatedAdmin,
    partId?: string,
  ): Promise<InventoryView> {
    this.requireManager(admin);
    const resultId = await this.operation(
      `PART:${partId ?? 'new'}`,
      input,
      admin,
      async (session) => {
        const labels: string[] = [];
        for (const modelId of input.modelIds) {
          const model = await this.models.findById(modelId).session(session);
          if (!model) throw new BadRequestException('A compatible device model does not exist');
          const brand = await this.brands.findById(model.brandId).session(session);
          labels.push(`${brand?.name ?? ''} ${model.name}`.trim());
        }
        if (
          input.supplierId &&
          !(await this.suppliers.exists({ _id: id(input.supplierId) }).session(session))
        )
          throw new BadRequestException('Supplier not found');
        const fields = {
          name: input.name,
          sku: input.sku,
          quality: input.quality,
          modelIds: input.modelIds.map(id),
          modelLabels: labels,
          supplierId: input.supplierId ? id(input.supplierId) : undefined,
          bin: input.bin,
          referenceCostInPaise: input.referenceCostInPaise,
          customerPriceInPaise: input.customerPriceInPaise,
          active: input.active,
        };
        let part: HydratedDocument<SparePartProfile>;
        if (partId) {
          part = await this.findPart(partId, session);
          if (version(part) !== input.expectedVersion) this.changed();
          if (part.sku !== input.sku)
            throw new BadRequestException('SKU cannot change after a part is created');
          const level = await this.levels
            .findOne({ variantId: part.variantId })
            .session(session)
            .orFail();
          if (!input.active && level.reserved > 0)
            throw new ConflictException('Release reserved parts before archiving this SKU');
          Object.assign(part, fields);
          await part.save({ session });
          await this.products.updateOne(
            { _id: part.productId, visibility: 'REPAIR_INTERNAL' },
            {
              $set: {
                name: input.name,
                'variants.0.title': input.quality,
                'variants.0.priceInPaise': input.customerPriceInPaise,
                'variants.0.isActive': input.active,
              },
              $inc: { version: 1 },
            },
            { session, runValidators: true },
          );
          await this.levels.updateOne(
            { variantId: part.variantId },
            { $set: { reorderPoint: input.reorderPoint }, $inc: { version: 1 } },
            { session },
          );
        } else {
          const productId = new Types.ObjectId();
          const variantId = new Types.ObjectId();
          part = new this.parts({ ...fields, productId, variantId });
          await new this.products({
            _id: productId,
            name: input.name,
            slug: `repair-part-${productId.toHexString()}`,
            description: 'Internal workshop spare part',
            visibility: 'REPAIR_INTERNAL',
            status: ProductStatus.Draft,
            variants: [
              {
                variantId,
                sku: input.sku,
                title: input.quality,
                priceInPaise: input.customerPriceInPaise,
                isActive: input.active,
                attributes: [],
              },
            ],
          }).save({ session });
          await part.save({ session });
          await new this.levels({
            productId,
            variantId,
            sku: input.sku,
            reorderPoint: input.reorderPoint,
            onHand: 0,
            reserved: 0,
            sold: 0,
            repairConsumed: 0,
          }).save({ session });
        }
        await this.auditEvent(admin, 'PART_SAVED', part.id, session);
        return part.id;
      },
    );
    return this.getPart(resultId, admin);
  }
  async listParts(query: InventoryQueryDto, admin: AuthenticatedAdmin): Promise<InventoryPage> {
    const filter = this.partFilter(query);
    const result = await this.parts.aggregate<{
      items: Array<{ _id: Types.ObjectId }>;
      total: Array<{ count: number }>;
    }>([
      { $match: filter },
      {
        $lookup: {
          from: 'inventory_levels',
          localField: 'variantId',
          foreignField: 'variantId',
          as: 'level',
        },
      },
      { $unwind: '$level' },
      ...(query.lowStock === 'true'
        ? [
            {
              $match: {
                $expr: {
                  $lte: [
                    { $subtract: ['$level.onHand', '$level.reserved'] },
                    '$level.reorderPoint',
                  ],
                },
              },
            },
          ]
        : []),
      { $sort: { sku: 1 } },
      {
        $facet: {
          items: [
            { $skip: (query.page - 1) * query.limit },
            { $limit: query.limit },
            { $project: { _id: 1 } },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    const rows = await this.parts
      .find({ _id: { $in: result[0].items.map((row) => row._id) } })
      .sort({ sku: 1 });
    return this.page(
      await Promise.all(rows.map((row) => this.partView(row, admin, false))),
      result[0].total[0]?.count ?? 0,
      query,
    );
  }
  async getPart(partId: string, admin: AuthenticatedAdmin): Promise<InventoryView> {
    return this.partView(await this.findPart(partId), admin, true);
  }
  async listLots(
    partId: string,
    query: InventoryQueryDto,
    admin: AuthenticatedAdmin,
  ): Promise<InventoryPage> {
    this.requireManager(admin);
    const part = await this.findPart(partId);
    const filter = {
      partId: part._id,
      ...(query.active === 'true' ? { remaining: { $gt: 0 } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.lots
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.lots.countDocuments(filter),
    ]);
    return this.page(
      rows.map((lot) => ({
        id: lot.id,
        source: lot.source,
        sourceId: lot.sourceId,
        supplierId: lot.supplierId?.toHexString(),
        purchaseId: lot.purchaseId?.toHexString(),
        quantity: lot.quantity,
        remaining: lot.remaining,
        unitCostInPaise: lot.unitCostInPaise,
        createdAt: lot.get('createdAt') as Date,
      })),
      total,
      query,
    );
  }
  async adjust(
    partId: string,
    input: StockAdjustmentDto,
    admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    this.requireManager(admin);
    await this.operation(`ADJUST:${partId}`, input, admin, async (session, key) => {
      const part = await this.findPart(partId, session);
      const level = await this.levels
        .findOne({ variantId: part.variantId })
        .session(session)
        .orFail();
      if (version(level) !== input.expectedVersion) this.changed();
      const incoming = ['OPENING', 'ADJUST_IN'].includes(input.action);
      if (incoming && input.lotId)
        throw new BadRequestException('Incoming adjustments create a new cost lot');
      if (!incoming && input.unitCostInPaise !== undefined)
        throw new BadRequestException('Outgoing cost comes from receipt lots');
      let allocations: RepairCostAllocation[] = [];
      if (incoming) {
        if (!part.active) throw new ConflictException('Unarchive the part before adding stock');
        if (input.action === 'OPENING') {
          if (
            part.openingRecorded ||
            (await this.lots.exists({ partId: part._id }).session(session))
          )
            throw new ConflictException(
              'Opening stock has already been established; use an adjustment',
            );
          part.openingRecorded = true;
          await part.save({ session });
        }
        await new this.lots({
          partId: part._id,
          source: input.action,
          sourceId: key,
          quantity: input.quantity,
          remaining: input.quantity,
          unitCostInPaise: input.unitCostInPaise,
        }).save({ session });
      } else {
        if ((input.action === 'SUPPLIER_RETURN') !== Boolean(input.lotId))
          throw new BadRequestException(
            'Supplier returns require their original supplier lot; other adjustments use FIFO',
          );
        allocations = await this.allocate(part._id, input.quantity, session, input.lotId);
      }
      await this.changeLevel(part, incoming ? input.quantity : -input.quantity, 0, 0, session);
      await this.movement(
        part,
        `REPAIR_${input.action}`,
        key,
        incoming ? input.quantity : -input.quantity,
        0,
        0,
        admin,
        input.reason,
        session,
        {
          ...this.cost(
            incoming
              ? [{ quantity: input.quantity, unitCostInPaise: input.unitCostInPaise }]
              : allocations,
          ),
          lotId: input.lotId ? id(input.lotId) : undefined,
        },
      );
      return part.id;
    });
    return this.getPart(partId, admin);
  }

  async createPurchase(input: PurchaseDto, admin: AuthenticatedAdmin): Promise<InventoryView> {
    this.requireManager(admin);
    const purchaseId = await this.operation('PURCHASE', input, admin, async (session) => {
      const supplier = await this.suppliers
        .findOne({ _id: id(input.supplierId), active: true })
        .session(session);
      if (!supplier) throw new BadRequestException('Choose an active supplier');
      if (new Set(input.lines.map((line) => line.partId)).size !== input.lines.length)
        throw new BadRequestException('Use one purchase line per SKU');
      const lines = [];
      for (const line of input.lines) {
        const part = await this.findPart(line.partId, session);
        if (!part.active) throw new ConflictException('Cannot purchase an archived part');
        lines.push({
          partId: part._id,
          sku: part.sku,
          name: part.name,
          ordered: line.quantity,
          received: 0,
          unitCostInPaise: line.unitCostInPaise,
        });
      }
      const purchase = await new this.purchases({
        number: `PO-${randomBytes(8).toString('hex').toUpperCase()}`,
        supplierId: supplier._id,
        supplierName: supplier.name,
        note: input.note,
        lines,
        createdBy: id(admin.id),
      }).save({ session });
      await this.auditEvent(admin, 'PURCHASE_CREATED', purchase.id, session);
      return purchase.id;
    });
    return this.getPurchase(purchaseId, admin);
  }
  async listPurchases(query: InventoryQueryDto, admin: AuthenticatedAdmin): Promise<InventoryPage> {
    this.requireManager(admin);
    const filter = query.search
      ? {
          $or: ['number', 'supplierName', 'lines.sku'].map((key) => ({
            [key]: { $regex: escape(query.search ?? ''), $options: 'i' },
          })),
        }
      : {};
    const [rows, total] = await Promise.all([
      this.purchases
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.purchases.countDocuments(filter),
    ]);
    return this.page(
      rows.map((row) => this.purchaseView(row)),
      total,
      query,
    );
  }
  async getPurchase(purchaseId: string, admin: AuthenticatedAdmin): Promise<InventoryView> {
    this.requireManager(admin);
    const purchase = await this.purchases.findById(id(purchaseId));
    if (!purchase) throw new NotFoundException('Purchase not found');
    const receipts = await this.receipts.find({ purchaseId: purchase._id }).sort({ createdAt: 1 });
    return {
      ...this.purchaseView(purchase),
      receipts: receipts.map((receipt) => ({
        id: receipt.id,
        reference: receipt.reference,
        note: receipt.note,
        createdAt: receipt.get('createdAt') as Date,
        lines: receipt.lines.map((line) => ({
          partId: line.partId.toHexString(),
          lineIndex: line.lineIndex,
          quantity: line.quantity,
          unitCostInPaise: line.unitCostInPaise,
        })),
      })),
    };
  }
  async receive(
    purchaseId: string,
    input: ReceiptDto,
    admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    this.requireManager(admin);
    await this.operation(`RECEIVE:${purchaseId}`, input, admin, async (session, key) => {
      const purchase = await this.purchases.findById(id(purchaseId)).session(session);
      if (!purchase) throw new NotFoundException('Purchase not found');
      if (version(purchase) !== input.expectedVersion) this.changed();
      if (!['OPEN', 'PARTIAL'].includes(purchase.status))
        throw new ConflictException('This purchase no longer accepts receipts');
      if (new Set(input.lines.map((line) => line.lineIndex)).size !== input.lines.length)
        throw new BadRequestException('Receive each purchase line once per receipt');
      const receipt = new this.receipts({
        purchaseId: purchase._id,
        supplierId: purchase.supplierId,
        reference: input.reference,
        note: input.note,
        receivedBy: id(admin.id),
        lines: [],
      });
      for (const received of input.lines) {
        const line = purchase.lines[received.lineIndex];
        if (!line || received.quantity > line.ordered - line.received)
          throw new ConflictException(
            'Received quantity exceeds the outstanding purchase quantity',
          );
        const part = await this.findPart(line.partId.toHexString(), session);
        if (!part.active) throw new ConflictException('Unarchive the part before receiving stock');
        await new this.lots({
          partId: part._id,
          source: 'RECEIPT',
          sourceId: key,
          supplierId: purchase.supplierId,
          purchaseId: purchase._id,
          quantity: received.quantity,
          remaining: received.quantity,
          unitCostInPaise: received.unitCostInPaise,
        }).save({ session });
        await this.changeLevel(part, received.quantity, 0, 0, session);
        await this.movement(
          part,
          'REPAIR_RECEIPT',
          `${key}:${received.lineIndex}`,
          received.quantity,
          0,
          0,
          admin,
          input.note.slice(0, 500),
          session,
          { purchaseId: purchase._id, ...this.cost([received]) },
        );
        line.received += received.quantity;
        receipt.lines.push({ partId: part._id, ...received });
      }
      purchase.status = purchase.lines.every((line) => line.received === line.ordered)
        ? 'RECEIVED'
        : 'PARTIAL';
      await purchase.save({ session });
      await receipt.save({ session });
      await this.auditEvent(admin, 'GOODS_RECEIVED', receipt.id, session);
      return purchase.id;
    });
    return this.getPurchase(purchaseId, admin);
  }
  async cancelPurchase(
    purchaseId: string,
    input: PurchaseCancelDto,
    admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    this.requireManager(admin);
    await this.operation(`CANCEL_PURCHASE:${purchaseId}`, input, admin, async (session) => {
      const purchase = await this.purchases.findById(id(purchaseId)).session(session);
      if (!purchase) throw new NotFoundException('Purchase not found');
      if (version(purchase) !== input.expectedVersion) this.changed();
      if (!['OPEN', 'PARTIAL'].includes(purchase.status))
        throw new ConflictException('Only outstanding purchase quantities can be cancelled');
      purchase.status = 'CANCELLED';
      purchase.cancellationReason = input.reason;
      await purchase.save({ session });
      await this.auditEvent(admin, 'PURCHASE_CANCELLED', purchase.id, session);
      return purchase.id;
    });
    return this.getPurchase(purchaseId, admin);
  }

  async jobParts(number: string, admin: AuthenticatedAdmin): Promise<InventoryView> {
    const job = await this.findJob(number, admin);
    const usages = await this.usages.find({ jobId: job._id }).sort({ createdAt: 1 });
    return {
      jobNumber: job.number,
      jobVersion: version(job),
      items: usages.map((usage) => ({
        id: usage.id,
        partId: usage.partId.toHexString(),
        sku: usage.sku,
        name: usage.name,
        quantity: usage.quantity,
        status: usage.status,
        estimateRevision: usage.estimateRevision,
        customerPriceInPaise: usage.customerPriceInPaise,
        compatibilityNote: usage.compatibilityNote,
        note: usage.note,
        returnedUsable: usage.returnedUsable,
        returnedDamaged: usage.returnedDamaged,
        consumedAt: usage.consumedAt,
        releasedAt: usage.releasedAt,
        ...(managesStock(admin)
          ? {
              ...this.cost(
                usage.allocations.map((allocation) => ({
                  quantity: allocation.quantity - allocation.returnedUsable,
                  unitCostInPaise: allocation.unitCostInPaise,
                })),
              ),
              allocations: usage.allocations.map((allocation) => ({
                lotId: allocation.lotId.toHexString(),
                quantity: allocation.quantity,
                unitCostInPaise: allocation.unitCostInPaise,
                returnedUsable: allocation.returnedUsable,
                returnedDamaged: allocation.returnedDamaged,
              })),
            }
          : {}),
      })),
    };
  }
  async reserve(
    number: string,
    input: ReservePartDto,
    admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    await this.findJob(number, admin);
    await this.operation(`RESERVE:${number}`, input, admin, async (session, key) => {
      const job = await this.findJob(number, admin, session);
      this.checkJob(job, input.expectedJobVersion);
      const estimate = job.estimates.at(-1);
      if (
        estimate?.approval?.decision !== 'APPROVED' ||
        ![
          RepairJobStatus.AwaitingApproval,
          RepairJobStatus.AwaitingParts,
          RepairJobStatus.Repairing,
        ].includes(job.status)
      )
        throw new ConflictException(
          'Reserve parts for the latest approved estimate before testing',
        );
      if ((await this.usages.countDocuments({ jobId: job._id }).session(session)) >= 200)
        throw new ConflictException('Job part allocation limit reached');
      const part = await this.findPart(input.partId, session);
      if (!part.active) throw new ConflictException('Part is archived');
      if (
        job.modelId &&
        part.modelIds.length &&
        !part.modelIds.some((model) => model.equals(job.modelId))
      )
        throw new ConflictException('This SKU is not compatible with the booked device model');
      await this.changeLevel(part, 0, input.quantity, 0, session);
      const reservation = await new this.reservations({
        reservationGroupId: `repair:${key}`,
        repairJobId: job._id,
        productId: part.productId,
        variantId: part.variantId,
        quantity: input.quantity,
        status: InventoryReservationStatus.Active,
      }).save({ session });
      const usage = await new this.usages({
        jobId: job._id,
        jobNumber: job.number,
        partId: part._id,
        reservationId: reservation._id,
        sku: part.sku,
        name: part.name,
        quantity: input.quantity,
        estimateRevision: estimate.revision,
        customerPriceInPaise: part.customerPriceInPaise,
        compatibilityNote: input.compatibilityNote,
        note: input.reason,
      }).save({ session });
      await this.movement(
        part,
        'REPAIR_RESERVE',
        key,
        0,
        input.quantity,
        0,
        admin,
        input.reason,
        session,
        { repairJobId: job._id },
      );
      await this.touchJob(
        job,
        admin,
        `Reserved ${input.quantity} × ${part.sku}. ${input.reason}`,
        session,
      );
      return usage.id;
    });
    return this.jobParts(number, admin);
  }
  async usePart(
    number: string,
    usageId: string,
    input: JobPartActionDto,
    admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    await this.findJob(number, admin);
    if (['RETURN_USABLE', 'RETURN_DAMAGED'].includes(input.action)) this.requireManager(admin);
    await this.operation(`USAGE:${number}:${usageId}`, input, admin, async (session, key) => {
      const job = await this.findJob(number, admin, session);
      if (version(job) !== input.expectedJobVersion) this.changed();
      const usage = await this.usages
        .findOne({ _id: id(usageId), jobId: job._id })
        .session(session);
      if (!usage) throw new NotFoundException('Part allocation not found');
      const part = await this.findPart(usage.partId.toHexString(), session);
      if (input.action === 'RELEASE') {
        if (input.quantity !== undefined)
          throw new BadRequestException('Release the full unused allocation');
        await this.release(usage, part, admin, input.reason, key, session);
      } else if (input.action === 'CONSUME') {
        this.checkJob(job, input.expectedJobVersion);
        if (!(
          managesStock(admin) ||
          (admin.roles.includes(AdminRole.Technician) &&
            job.technicianId?.toHexString() === admin.id)
        ))
          throw new ForbiddenException(
            'Only the assigned technician or owner/staff can consume parts',
          );
        if (
          job.status !== RepairJobStatus.Repairing ||
          job.estimates.at(-1)?.approval?.decision !== 'APPROVED' ||
          job.estimates.at(-1)?.revision !== usage.estimateRevision
        )
          throw new ConflictException(
            'Consumption requires repair in progress against the reserved approved estimate',
          );
        if (usage.status !== 'RESERVED' || input.quantity !== undefined)
          throw new ConflictException('Consume a complete, active reservation once');
        usage.allocations = await this.allocate(part._id, usage.quantity, session);
        usage.status = 'CONSUMED';
        usage.consumedAt = new Date();
        await this.changeLevel(part, -usage.quantity, -usage.quantity, usage.quantity, session);
        await this.finalizeReservation(usage, InventoryReservationStatus.Committed, session);
        await usage.save({ session });
        await this.movement(
          part,
          'REPAIR_CONSUME',
          key,
          -usage.quantity,
          -usage.quantity,
          usage.quantity,
          admin,
          input.reason,
          session,
          { repairJobId: job._id, ...this.cost(usage.allocations) },
        );
      } else {
        if (
          usage.status !== 'CONSUMED' ||
          !input.quantity ||
          input.quantity > usage.quantity - usage.returnedUsable - usage.returnedDamaged
        )
          throw new ConflictException('Return quantity exceeds consumed, unreturned parts');
        let remaining = input.quantity;
        const returned: Array<{ quantity: number; unitCostInPaise?: number }> = [];
        for (const allocation of usage.allocations) {
          const quantity = Math.min(
            remaining,
            allocation.quantity - allocation.returnedUsable - allocation.returnedDamaged,
          );
          if (!quantity) continue;
          if (input.action === 'RETURN_USABLE') {
            const changed = await this.lots.updateOne(
              {
                _id: allocation.lotId,
                $expr: { $lte: [{ $add: ['$remaining', quantity] }, '$quantity'] },
              },
              { $inc: { remaining: quantity, version: 1 } },
              { session },
            );
            if (changed.modifiedCount !== 1)
              throw new ConflictException('Original cost lot is unavailable for a return');
            allocation.returnedUsable += quantity;
          } else allocation.returnedDamaged += quantity;
          returned.push({ quantity, unitCostInPaise: allocation.unitCostInPaise });
          remaining -= quantity;
          if (!remaining) break;
        }
        if (remaining) throw new ConflictException('Issue cost allocations do not reconcile');
        const usable = input.action === 'RETURN_USABLE';
        usage.returnedUsable += usable ? input.quantity : 0;
        usage.returnedDamaged += usable ? 0 : input.quantity;
        await this.changeLevel(
          part,
          usable ? input.quantity : 0,
          0,
          usable ? -input.quantity : 0,
          session,
        );
        await usage.save({ session });
        await this.movement(
          part,
          `REPAIR_${input.action}`,
          key,
          usable ? input.quantity : 0,
          0,
          usable ? -input.quantity : 0,
          admin,
          input.reason,
          session,
          { repairJobId: job._id, ...this.cost(returned) },
        );
      }
      await this.touchJob(job, admin, `${input.action}: ${usage.sku}. ${input.reason}`, session);
      return usage.id;
    });
    return this.jobParts(number, admin);
  }

  // Called inside the job transaction: cancellation/quote revision/handover cannot race consumption.
  async releaseForJob(
    job: RepairJobDocument,
    admin: AuthenticatedAdmin,
    reason: string,
    session: ClientSession,
  ): Promise<void> {
    const active = await this.usages.find({ jobId: job._id, status: 'RESERVED' }).session(session);
    for (const usage of active)
      await this.release(
        usage,
        await this.findPart(usage.partId.toHexString(), session),
        admin,
        reason,
        `job:${job.id}:${version(job)}:${usage.id}`,
        session,
      );
  }
  async listMovements(query: InventoryQueryDto, admin: AuthenticatedAdmin): Promise<InventoryPage> {
    this.requireManager(admin);
    const filter: Record<string, unknown> = { referenceType: /^REPAIR_/ };
    if (query.partId) filter.partId = id(query.partId);
    if (query.search || query.modelId) {
      const rows = await this.parts.find(this.partFilter(query)).select('_id');
      filter.partId = {
        $in: rows
          .map((part) => part._id)
          .filter((partId) => !query.partId || partId.equals(query.partId)),
      };
    }
    if (query.jobNumber) {
      const job = await this.jobs.findOne({ number: query.jobNumber }).select('_id');
      filter.repairJobId = job?._id ?? new Types.ObjectId();
    }
    const [rows, total] = await Promise.all([
      this.movements
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit),
      this.movements.countDocuments(filter),
    ]);
    return this.page(
      rows.map((row) => ({
        id: row.id,
        partId: row.partId?.toHexString(),
        sku: row.sku,
        action: row.referenceType,
        deltaOnHand: row.deltaOnHand,
        deltaReserved: row.deltaReserved,
        deltaConsumed: row.deltaConsumed ?? 0,
        knownCostInPaise: row.costInPaise,
        unknownCostQuantity: row.unknownCostQuantity,
        note: row.note,
        jobId: row.repairJobId?.toHexString(),
        purchaseId: row.purchaseId?.toHexString(),
        lotId: row.lotId?.toHexString(),
        actorId: row.actorId?.toHexString(),
        createdAt: row.get('createdAt') as Date,
      })),
      total,
      query,
    );
  }

  private async release(
    usage: HydratedDocument<RepairPartUsage>,
    part: HydratedDocument<SparePartProfile>,
    admin: AuthenticatedAdmin,
    reason: string,
    key: string,
    session: ClientSession,
  ): Promise<void> {
    if (usage.status !== 'RESERVED')
      throw new ConflictException('Only unused reservations can be released');
    await this.changeLevel(part, 0, -usage.quantity, 0, session);
    await this.finalizeReservation(usage, InventoryReservationStatus.Released, session);
    usage.status = 'RELEASED';
    usage.releasedAt = new Date();
    await usage.save({ session });
    await this.movement(
      part,
      'REPAIR_RELEASE',
      key,
      0,
      -usage.quantity,
      0,
      admin,
      reason.slice(0, 500),
      session,
      { repairJobId: usage.jobId },
    );
  }
  private async finalizeReservation(
    usage: HydratedDocument<RepairPartUsage>,
    status: InventoryReservationStatus,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.reservations.updateOne(
      {
        _id: usage.reservationId,
        repairJobId: usage.jobId,
        status: InventoryReservationStatus.Active,
      },
      { $set: { status, finalizedAt: new Date() }, $inc: { version: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1) throw new ConflictException('Part reservation changed');
  }
  private async allocate(
    partId: Types.ObjectId,
    quantity: number,
    session: ClientSession,
    lotId?: string,
  ): Promise<RepairCostAllocation[]> {
    const lots = await this.lots
      .find({
        partId,
        remaining: { $gt: 0 },
        ...(lotId ? { _id: id(lotId), supplierId: { $exists: true } } : {}),
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(quantity)
      .session(session);
    const result: RepairCostAllocation[] = [];
    let remaining = quantity;
    for (const lot of lots) {
      const take = Math.min(remaining, lot.remaining);
      lot.remaining -= take;
      await lot.save({ session });
      result.push({
        lotId: lot._id,
        quantity: take,
        unitCostInPaise: lot.unitCostInPaise,
        returnedUsable: 0,
        returnedDamaged: 0,
      });
      remaining -= take;
      if (!remaining) break;
    }
    if (remaining) throw new ConflictException('Insufficient stock in the selected cost lots');
    return result;
  }
  private async changeLevel(
    part: HydratedDocument<SparePartProfile>,
    onHand: number,
    reserved: number,
    consumed: number,
    session: ClientSession,
  ): Promise<void> {
    const nextOnHand = { $add: ['$onHand', onHand] };
    const nextReserved = { $add: ['$reserved', reserved] };
    const nextConsumed = { $add: [{ $ifNull: ['$repairConsumed', 0] }, consumed] };
    const result = await this.levels.updateOne(
      {
        variantId: part.variantId,
        productId: part.productId,
        $expr: {
          $and: [
            { $gte: [nextOnHand, 0] },
            { $lte: [nextOnHand, 1000000] },
            { $gte: [nextReserved, 0] },
            { $lte: [nextReserved, nextOnHand] },
            { $gte: [nextConsumed, 0] },
          ],
        },
      },
      { $inc: { onHand, reserved, repairConsumed: consumed, version: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1)
      throw new ConflictException(
        'Insufficient available stock, or stock changed. Reserved parts cannot be removed.',
      );
  }
  private async movement(
    part: HydratedDocument<SparePartProfile>,
    action: string,
    key: string,
    onHand: number,
    reserved: number,
    consumed: number,
    admin: AuthenticatedAdmin,
    note: string,
    session: ClientSession,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await new this.movements({
      productId: part.productId,
      variantId: part.variantId,
      partId: part._id,
      sku: part.sku,
      type: InventoryMovementType.Repair,
      deltaOnHand: onHand,
      deltaReserved: reserved,
      deltaSold: 0,
      deltaConsumed: consumed,
      referenceType: action,
      referenceId: key,
      actorId: id(admin.id),
      note,
      ...extra,
    }).save({ session });
    await this.auditEvent(admin, action, part.id, session, {
      operationKey: key,
      onHand,
      reserved,
      consumed,
    });
  }
  private cost(allocations: Array<{ quantity: number; unitCostInPaise?: number }>): {
    costInPaise: number;
    unknownCostQuantity: number;
  } {
    return allocations.reduce(
      (total, allocation) => ({
        costInPaise: total.costInPaise + (allocation.unitCostInPaise ?? 0) * allocation.quantity,
        unknownCostQuantity:
          total.unknownCostQuantity +
          (allocation.unitCostInPaise === undefined ? allocation.quantity : 0),
      }),
      { costInPaise: 0, unknownCostQuantity: 0 },
    );
  }
  private async operation(
    kind: string,
    input: StockOperationDto,
    admin: AuthenticatedAdmin,
    work: (session: ClientSession, key: string) => Promise<string>,
  ): Promise<string> {
    const key = `${admin.id}:${input.idempotencyKey}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(canonical({ kind, input })))
      .digest('hex');
    const replay = async (session?: ClientSession): Promise<string | undefined> => {
      const prior = await this.operations.findOne({ key }).session(session ?? null);
      if (!prior) return undefined;
      if (prior.requestHash !== requestHash)
        throw new ConflictException('This operation key was used for different details');
      return prior.resultId;
    };
    const existing = await replay();
    if (existing) return existing;
    try {
      return await this.connection.transaction(async (session) => {
        const prior = await replay(session);
        if (prior) return prior;
        const resultId = await work(session, key);
        await new this.operations({ key, kind, requestHash, resultId, actorId: id(admin.id) }).save(
          { session },
        );
        return resultId;
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const prior = await replay();
        if (prior) return prior;
        throw new ConflictException('This SKU, supplier code or operation already exists');
      }
      throw error;
    }
  }
  private async findPart(
    partId: string,
    session?: ClientSession,
  ): Promise<HydratedDocument<SparePartProfile>> {
    const part = await this.parts.findById(id(partId)).session(session ?? null);
    if (!part) throw new NotFoundException('Part not found');
    return part;
  }
  private async findJob(
    number: string,
    admin: AuthenticatedAdmin,
    session?: ClientSession,
  ): Promise<RepairJobDocument> {
    const access = admin.roles.some((role) =>
      [AdminRole.Owner, AdminRole.Staff, AdminRole.Reception].includes(role),
    );
    const job = await this.jobs
      .findOne({ number, ...(access ? {} : { technicianId: id(admin.id) }) })
      .session(session ?? null);
    if (!job) throw new NotFoundException('Job not found or unavailable');
    return job;
  }
  private checkJob(job: RepairJobDocument, expected: number): void {
    if (version(job) !== expected) this.changed();
    if (
      [RepairJobStatus.Delivered, RepairJobStatus.Cancelled, RepairJobStatus.Unrepairable].includes(
        job.status,
      )
    )
      throw new ConflictException('This job is closed');
  }
  private async touchJob(
    job: RepairJobDocument,
    admin: AuthenticatedAdmin,
    reason: string,
    session: ClientSession,
  ): Promise<void> {
    if (job.history.length >= 1000) throw new ConflictException('Job history limit reached');
    job.history.push({
      at: new Date(),
      actorId: id(admin.id),
      actorName: admin.name,
      action: 'PARTS',
      status: job.status,
      reason,
    });
    await job.save({ session });
  }
  private async auditEvent(
    admin: AuthenticatedAdmin,
    action: string,
    resourceId: string,
    session: ClientSession,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      { action, resourceType: 'REPAIR_INVENTORY', resourceId, actorId: admin.id, metadata },
      session,
    );
  }
  private requireManager(admin: AuthenticatedAdmin): void {
    if (!managesStock(admin))
      throw new ForbiddenException('Owner or staff inventory access is required');
  }
  private changed(): never {
    throw new ConflictException('This record changed. Refresh before trying again.');
  }
  private page(items: InventoryView[], total: number, query: InventoryQueryDto): InventoryPage {
    return { items, total, page: query.page, totalPages: Math.ceil(total / query.limit) };
  }
  private partFilter(query: InventoryQueryDto): Record<string, unknown> {
    return {
      ...(query.active ? { active: query.active === 'true' } : {}),
      ...(query.modelId ? { modelIds: id(query.modelId) } : {}),
      ...(query.search
        ? {
            $or: ['sku', 'name', 'quality', 'modelLabels'].map((key) => ({
              [key]: { $regex: escape(query.search ?? ''), $options: 'i' },
            })),
          }
        : {}),
    };
  }
  private supplierView(row: HydratedDocument<RepairSupplier>): InventoryView {
    return {
      id: row.id,
      version: version(row),
      name: row.name,
      code: row.code,
      contactName: row.contactName,
      phone: row.phone,
      email: row.email,
      address: row.address,
      active: row.active,
    };
  }
  private purchaseView(row: HydratedDocument<RepairPurchase>): InventoryView {
    return {
      id: row.id,
      version: version(row),
      number: row.number,
      supplierId: row.supplierId.toHexString(),
      supplierName: row.supplierName,
      status: row.status,
      note: row.note,
      cancellationReason: row.cancellationReason,
      createdAt: row.get('createdAt') as Date,
      lines: row.lines.map((line) => ({
        partId: line.partId.toHexString(),
        sku: line.sku,
        name: line.name,
        ordered: line.ordered,
        received: line.received,
        unitCostInPaise: line.unitCostInPaise,
      })),
    };
  }
  private async partView(
    part: HydratedDocument<SparePartProfile>,
    admin: AuthenticatedAdmin,
    detail: boolean,
  ): Promise<InventoryView> {
    const level = await this.levels.findOne({ variantId: part.variantId }).orFail();
    const manager = managesStock(admin);
    const lots =
      detail && manager
        ? await this.lots.find({ partId: part._id }).sort({ createdAt: 1, _id: 1 }).limit(500)
        : [];
    return {
      id: part.id,
      version: version(part),
      sku: part.sku,
      name: part.name,
      quality: part.quality,
      modelIds: part.modelIds.map((model) => model.toHexString()),
      modelLabels: part.modelLabels,
      bin: part.bin,
      customerPriceInPaise: part.customerPriceInPaise,
      active: part.active,
      openingRecorded: part.openingRecorded,
      stock: {
        version: version(level),
        onHand: level.onHand,
        reserved: level.reserved,
        available: level.onHand - level.reserved,
        repairConsumed: level.repairConsumed ?? 0,
        reorderPoint: level.reorderPoint,
        lowStock: level.onHand - level.reserved <= level.reorderPoint,
      },
      ...(manager
        ? {
            productId: part.productId.toHexString(),
            variantId: part.variantId.toHexString(),
            supplierId: part.supplierId?.toHexString(),
            referenceCostInPaise: part.referenceCostInPaise,
            lots: lots.map((lot) => ({
              id: lot.id,
              source: lot.source,
              sourceId: lot.sourceId,
              supplierId: lot.supplierId?.toHexString(),
              purchaseId: lot.purchaseId?.toHexString(),
              quantity: lot.quantity,
              remaining: lot.remaining,
              unitCostInPaise: lot.unitCostInPaise,
              createdAt: lot.get('createdAt') as Date,
            })),
          }
        : {}),
    };
  }
}
