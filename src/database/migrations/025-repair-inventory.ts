import { isDeepStrictEqual } from 'node:util';
import type { Document } from 'mongodb';
import type { DatabaseMigration, MigrationContext } from './migration';
const text = (maxLength: number, minLength = 1): Document => ({
  bsonType: 'string',
  minLength,
  maxLength,
});
const integer = (maximum = 1000000, minimum = 0): Document => ({
  bsonType: 'number',
  minimum,
  maximum,
  multipleOf: 1,
});
const money = integer(1000000000);
const id = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const common = { createdAt: date, updatedAt: date, version: integer(Number.MAX_SAFE_INTEGER) };
const object = (required: string[], properties: Document): Document => ({
  bsonType: 'object',
  ...(required.length ? { required } : {}),
  properties,
});
const array = (items: Document, maxItems: number, minItems = 0): Document => ({
  bsonType: 'array',
  items,
  maxItems,
  minItems,
});
async function validator(context: MigrationContext, collection: string): Promise<Document> {
  const info = await context.database
    .listCollections({ name: collection }, { nameOnly: false })
    .next();
  if (!info?.options?.validator) throw new Error(`Missing validator: ${collection}`);
  return info.options.validator as Document;
}
function conjuncts(rule: Document): Document[] {
  return Object.keys(rule).length === 1 && Array.isArray(rule.$and)
    ? (rule.$and as Document[]).flatMap(conjuncts)
    : [rule];
}
async function set(context: MigrationContext, collection: string, rules: Document): Promise<void> {
  await context.database.command({
    collMod: collection,
    validator: {
      $and: conjuncts(rules).filter(
        (rule, index, all) =>
          all.findIndex((candidate) => isDeepStrictEqual(candidate, rule)) === index,
      ),
    },
    validationLevel: 'strict',
    validationAction: 'error',
  });
}
function expand(value: unknown, match: string, addition: string): void {
  if (Array.isArray(value)) {
    value.forEach((child) => expand(child, match, addition));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entry = value as Record<string, unknown>;
  if (Array.isArray(entry.enum) && entry.enum.includes(match) && !entry.enum.includes(addition))
    entry.enum.push(addition);
  Object.values(entry).forEach((child) => expand(child, match, addition));
}
export const repairInventoryMigration: DatabaseMigration = {
  id: '025-repair-inventory',
  description:
    'Extend the shared ledger with private spare parts, FIFO cost lots, supplier receipts and repair consumption',
  async up(context): Promise<void> {
    const definitions: Array<{
      model: string;
      collection: string;
      required: string[];
      properties: Document;
      rules?: Document[];
    }> = [
      {
        model: 'RepairSupplier',
        collection: 'repair_suppliers',
        required: ['name', 'code', 'active'],
        properties: {
          name: text(120, 2),
          code: { ...text(40, 2), pattern: '^[A-Z0-9][A-Z0-9_-]*$' },
          contactName: text(120, 0),
          phone: text(20),
          email: text(254),
          address: text(1000, 0),
          active: { bsonType: 'bool' },
        },
      },
      {
        model: 'SparePartProfile',
        collection: 'spare_part_profiles',
        required: [
          'productId',
          'variantId',
          'sku',
          'name',
          'quality',
          'modelIds',
          'modelLabels',
          'customerPriceInPaise',
          'active',
          'openingRecorded',
        ],
        properties: {
          productId: id,
          variantId: id,
          sku: text(100, 2),
          name: text(160, 2),
          quality: text(120, 2),
          modelIds: { ...array(id, 50), uniqueItems: true },
          modelLabels: array(text(241), 50),
          supplierId: id,
          bin: text(120, 0),
          referenceCostInPaise: money,
          customerPriceInPaise: money,
          active: { bsonType: 'bool' },
          openingRecorded: { bsonType: 'bool' },
        },
      },
      {
        model: 'RepairStockLot',
        collection: 'repair_stock_lots',
        required: ['partId', 'source', 'sourceId', 'quantity', 'remaining'],
        properties: {
          partId: id,
          source: { enum: ['OPENING', 'RECEIPT', 'ADJUST_IN'] },
          sourceId: text(100),
          supplierId: id,
          purchaseId: id,
          quantity: integer(100000, 1),
          remaining: integer(100000),
          unitCostInPaise: money,
        },
        rules: [{ $expr: { $lte: ['$remaining', '$quantity'] } }],
      },
      {
        model: 'RepairPurchase',
        collection: 'repair_purchases',
        required: ['number', 'supplierId', 'supplierName', 'status', 'lines', 'note', 'createdBy'],
        properties: {
          number: { ...text(19), pattern: '^PO-[A-F0-9]{16}$' },
          supplierId: id,
          supplierName: text(120),
          status: { enum: ['OPEN', 'PARTIAL', 'RECEIVED', 'CANCELLED'] },
          note: text(1000, 3),
          cancellationReason: text(1000, 3),
          createdBy: id,
          lines: array(
            object(['partId', 'sku', 'name', 'ordered', 'received', 'unitCostInPaise'], {
              partId: id,
              sku: text(100),
              name: text(160),
              ordered: integer(100000, 1),
              received: integer(100000),
              unitCostInPaise: money,
            }),
            30,
            1,
          ),
        },
        rules: [
          {
            $expr: {
              $allElementsTrue: [
                {
                  $map: {
                    input: '$lines',
                    as: 'line',
                    in: { $lte: ['$$line.received', '$$line.ordered'] },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        model: 'RepairGoodsReceipt',
        collection: 'repair_goods_receipts',
        required: ['purchaseId', 'supplierId', 'reference', 'note', 'lines', 'receivedBy'],
        properties: {
          purchaseId: id,
          supplierId: id,
          reference: text(120, 2),
          note: text(1000, 3),
          receivedBy: id,
          lines: array(
            object(['partId', 'lineIndex', 'quantity', 'unitCostInPaise'], {
              partId: id,
              lineIndex: integer(29),
              quantity: integer(100000, 1),
              unitCostInPaise: money,
            }),
            30,
            1,
          ),
        },
      },
      {
        model: 'RepairPartUsage',
        collection: 'repair_part_usages',
        required: [
          'jobId',
          'jobNumber',
          'partId',
          'reservationId',
          'sku',
          'name',
          'quantity',
          'estimateRevision',
          'customerPriceInPaise',
          'status',
          'compatibilityNote',
          'note',
          'allocations',
          'returnedUsable',
          'returnedDamaged',
        ],
        properties: {
          jobId: id,
          jobNumber: { ...text(20), pattern: '^JOB-[A-F0-9]{16}$' },
          partId: id,
          reservationId: id,
          sku: text(100),
          name: text(160),
          quantity: integer(100, 1),
          estimateRevision: integer(100, 1),
          customerPriceInPaise: money,
          status: { enum: ['RESERVED', 'CONSUMED', 'RELEASED'] },
          compatibilityNote: text(500, 3),
          note: text(500, 3),
          consumedAt: date,
          releasedAt: date,
          returnedUsable: integer(100),
          returnedDamaged: integer(100),
          allocations: array(
            object(['lotId', 'quantity', 'returnedUsable', 'returnedDamaged'], {
              lotId: id,
              quantity: integer(100, 1),
              unitCostInPaise: money,
              returnedUsable: integer(100),
              returnedDamaged: integer(100),
            }),
            100,
          ),
        },
        rules: [
          { $expr: { $lte: [{ $add: ['$returnedUsable', '$returnedDamaged'] }, '$quantity'] } },
          {
            $or: [
              {
                status: { $in: ['RESERVED', 'RELEASED'] },
                allocations: { $size: 0 },
                returnedUsable: 0,
                returnedDamaged: 0,
              },
              {
                status: 'CONSUMED',
                consumedAt: { $type: 'date' },
                $expr: {
                  $and: [
                    { $eq: [{ $sum: '$allocations.quantity' }, '$quantity'] },
                    { $eq: [{ $sum: '$allocations.returnedUsable' }, '$returnedUsable'] },
                    { $eq: [{ $sum: '$allocations.returnedDamaged' }, '$returnedDamaged'] },
                    {
                      $allElementsTrue: [
                        {
                          $map: {
                            input: '$allocations',
                            as: 'lot',
                            in: {
                              $lte: [
                                { $add: ['$$lot.returnedUsable', '$$lot.returnedDamaged'] },
                                '$$lot.quantity',
                              ],
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        model: 'RepairStockOperation',
        collection: 'repair_stock_operations',
        required: ['key', 'requestHash', 'kind', 'resultId', 'actorId'],
        properties: {
          key: text(100),
          requestHash: { ...text(64), pattern: '^[a-f0-9]{64}$' },
          kind: text(120),
          resultId: text(100),
          actorId: id,
        },
      },
    ];
    for (const definition of definitions) {
      const model = context.connection.model(definition.model);
      if (!(await context.database.listCollections({ name: definition.collection }).hasNext()))
        await model.createCollection();
      await model.createIndexes();
      await set(context, definition.collection, {
        $and: [
          {
            $jsonSchema: object([...definition.required, 'version', 'createdAt', 'updatedAt'], {
              ...common,
              ...definition.properties,
            }),
          },
          ...(definition.rules ?? []),
        ],
      });
    }
    await set(context, 'products', {
      $and: [
        await validator(context, 'products'),
        { $jsonSchema: object([], { visibility: { enum: ['PUBLIC', 'REPAIR_INTERNAL'] } }) },
        {
          $or: [{ visibility: { $ne: 'REPAIR_INTERNAL' } }, { status: 'DRAFT', isFeatured: false }],
        },
      ],
    });
    await set(context, 'inventory_levels', {
      $and: [
        await validator(context, 'inventory_levels'),
        { $jsonSchema: object([], { repairConsumed: integer(Number.MAX_SAFE_INTEGER) }) },
      ],
    });
    const movement = await validator(context, 'inventory_movements');
    expand(movement, 'RESTOCK', 'REPAIR');
    await set(context, 'inventory_movements', {
      $and: [
        movement,
        {
          $jsonSchema: object([], {
            partId: id,
            repairJobId: id,
            purchaseId: id,
            lotId: id,
            sku: text(100),
            deltaConsumed: {
              ...integer(Number.MAX_SAFE_INTEGER),
              minimum: -Number.MAX_SAFE_INTEGER,
            },
            costInPaise: integer(Number.MAX_SAFE_INTEGER),
            unknownCostQuantity: integer(),
          }),
        },
        {
          $or: [
            { type: { $ne: 'REPAIR' } },
            {
              partId: { $type: 'objectId' },
              sku: { $type: 'string' },
              deltaConsumed: { $type: 'number' },
              deltaSold: 0,
              referenceType: /^REPAIR_/,
            },
          ],
        },
      ],
    });
    // Replace the old two-owner expression and unconditional expiry requirement together.
    await set(context, 'inventory_reservations', {
      $and: [
        {
          $jsonSchema: object(
            ['reservationGroupId', 'productId', 'variantId', 'quantity', 'status'],
            {
              reservationGroupId: text(100),
              productId: id,
              variantId: id,
              quantity: integer(Number.MAX_SAFE_INTEGER, 1),
              status: { enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'] },
              orderId: id,
              returnRequestId: id,
              repairJobId: id,
              expiresAt: date,
              finalizedAt: date,
              ...common,
            },
          ),
        },
        {
          $or: [
            {
              orderId: { $type: 'objectId' },
              returnRequestId: { $exists: false },
              repairJobId: { $exists: false },
              expiresAt: { $type: 'date' },
            },
            {
              returnRequestId: { $type: 'objectId' },
              orderId: { $exists: false },
              repairJobId: { $exists: false },
              expiresAt: { $type: 'date' },
              reservationGroupId: /^exchange:[a-f0-9]{24}$/,
            },
            {
              repairJobId: { $type: 'objectId' },
              orderId: { $exists: false },
              returnRequestId: { $exists: false },
              expiresAt: { $exists: false },
              reservationGroupId: /^repair:/,
              status: { $ne: 'EXPIRED' },
            },
          ],
        },
      ],
    });
    const jobs = await validator(context, 'repair_jobs');
    expand(jobs, 'INTAKE', 'PARTS');
    await set(context, 'repair_jobs', {
      $and: [jobs, { $jsonSchema: object([], { modelId: id }) }],
    });
    for (const name of ['InventoryLevel', 'InventoryReservation', 'InventoryMovement'])
      await context.connection.model(name).createIndexes();
  },
};
