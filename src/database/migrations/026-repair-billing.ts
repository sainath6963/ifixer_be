import { isDeepStrictEqual } from 'node:util';
import type { Document } from 'mongodb';
import type { DatabaseMigration } from './migration';
const text = (maxLength: number, minLength = 1): Document => ({
  bsonType: 'string',
  minLength,
  maxLength,
});
const integer = (maximum = 1000000000, minimum = 0): Document => ({
  bsonType: 'number',
  minimum,
  maximum,
  multipleOf: 1,
});
const id = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
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
const issuer = object(['name', 'address', 'phone'], {
  name: text(160, 2),
  address: text(1000, 5),
  phone: { ...text(20), pattern: '^\\+?[1-9]\\d{7,14}$' },
  taxId: text(80, 2),
});
const tax = { label: text(80, 2), rateBps: integer(10000) };
const common = { version: integer(), createdAt: date, updatedAt: date };
const jobNumber = { ...text(20), pattern: '^JOB-[A-F0-9]{16}$' };
const invoiceNumber = { ...text(20), pattern: '^INV-[0-9]{6,9}$' };
const money = integer();
function extendActions(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(extendActions);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const entry = value as Record<string, unknown>;
  if (Array.isArray(entry.enum) && entry.enum.includes('INTAKE') && !entry.enum.includes('BILLING'))
    entry.enum.push('BILLING');
  Object.values(entry).forEach(extendActions);
}
function conjuncts(rule: Document): Document[] {
  return Object.keys(rule).length === 1 && Array.isArray(rule.$and)
    ? (rule.$and as Document[]).flatMap(conjuncts)
    : [rule];
}
export const repairBillingMigration: DatabaseMigration = {
  id: '026-repair-billing',
  description:
    'Immutable repair invoices, manual money ledger, owner billing configuration, delivery balance authorization and warranty follow-ups',
  async up({ connection, database }): Promise<void> {
    const definitions: Array<{
      model: string;
      required: string[];
      properties: Document;
      rules?: Document[];
    }> = [
      {
        model: 'RepairBillingSettings',
        required: [
          'key',
          'issuer',
          'taxes',
          'warrantyDays',
          'warrantyCoverage',
          'warrantyExclusions',
        ],
        properties: {
          key: { enum: ['SHOP'] },
          issuer,
          taxes: array(object(['label', 'rateBps'], tax), 5),
          warrantyDays: integer(1095),
          warrantyCoverage: text(2000, 3),
          warrantyExclusions: text(2000, 3),
          invoiceNote: text(1000, 0),
        },
        rules: [{ $expr: { $lte: [{ $sum: '$taxes.rateBps' }, 10000] } }],
      },
      {
        model: 'RepairInvoice',
        required: [
          'number',
          'jobId',
          'jobNumber',
          'issuer',
          'customerName',
          'phone',
          'deviceLabel',
          'estimateRevision',
          'lines',
          'subtotalInPaise',
          'discountInPaise',
          'taxableInPaise',
          'taxes',
          'totalInPaise',
          'warrantyDays',
          'warrantyCoverage',
          'warrantyExclusions',
          'issuedBy',
          'issuedByName',
        ],
        properties: {
          number: invoiceNumber,
          jobId: id,
          jobNumber,
          issuer,
          customerName: text(120, 2),
          phone: text(20),
          deviceLabel: text(400, 2),
          imei: { ...text(15), pattern: '^\\d{15}$' },
          serial: text(120),
          estimateRevision: integer(100, 1),
          lines: array(
            object(['kind', 'description', 'quantity', 'unitPriceInPaise'], {
              kind: { enum: ['PART', 'LABOUR', 'SERVICE'] },
              description: text(160, 2),
              quantity: integer(100, 1),
              unitPriceInPaise: money,
            }),
            30,
            1,
          ),
          subtotalInPaise: money,
          discountInPaise: money,
          taxableInPaise: money,
          taxes: array(
            object(['label', 'rateBps', 'amountInPaise'], { ...tax, amountInPaise: money }),
            5,
          ),
          totalInPaise: money,
          warrantyDays: integer(1095),
          warrantyCoverage: text(2000, 3),
          warrantyExclusions: text(2000, 3),
          note: text(1000, 0),
          issuedBy: id,
          issuedByName: text(120),
        },
        rules: [
          {
            $expr: {
              $and: [
                {
                  $eq: [
                    '$subtotalInPaise',
                    {
                      $sum: {
                        $map: {
                          input: '$lines',
                          as: 'line',
                          in: { $multiply: ['$$line.quantity', '$$line.unitPriceInPaise'] },
                        },
                      },
                    },
                  ],
                },
                { $lte: ['$discountInPaise', '$subtotalInPaise'] },
                {
                  $eq: ['$taxableInPaise', { $subtract: ['$subtotalInPaise', '$discountInPaise'] }],
                },
                {
                  $eq: [
                    '$totalInPaise',
                    { $add: ['$taxableInPaise', { $sum: '$taxes.amountInPaise' }] },
                  ],
                },
                {
                  $allElementsTrue: [
                    {
                      $map: {
                        input: '$taxes',
                        as: 'tax',
                        in: {
                          $eq: [
                            '$$tax.amountInPaise',
                            {
                              $floor: {
                                $divide: [
                                  {
                                    $add: [
                                      { $multiply: ['$taxableInPaise', '$$tax.rateBps'] },
                                      5000,
                                    ],
                                  },
                                  10000,
                                ],
                              },
                            },
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
      {
        model: 'RepairMoneyEntry',
        required: [
          'number',
          'jobId',
          'jobNumber',
          'kind',
          'amountInPaise',
          'reason',
          'issuer',
          'customerName',
          'recordedBy',
          'recordedByName',
        ],
        properties: {
          number: { ...text(20), pattern: '^(RCP|REF|CRN)-[0-9]{6,9}$' },
          jobId: id,
          jobNumber,
          kind: { enum: ['PAYMENT', 'REFUND', 'CREDIT'] },
          amountInPaise: integer(1000000000, 1),
          method: { enum: ['CASH', 'UPI'] },
          reference: { ...text(100), pattern: '^[A-Z0-9][A-Z0-9._:/-]{2,99}$' },
          paymentId: id,
          paymentNumber: { ...text(20), pattern: '^RCP-[0-9]{6,9}$' },
          invoiceNumber,
          invoiceId: id,
          reason: text(500, 3),
          issuer,
          customerName: text(120, 2),
          recordedBy: id,
          recordedByName: text(120),
        },
        rules: [
          {
            $or: [
              {
                kind: 'PAYMENT',
                number: /^RCP-/,
                method: { $in: ['CASH', 'UPI'] },
                paymentId: { $exists: false },
              },
              {
                kind: 'REFUND',
                number: /^REF-/,
                method: { $in: ['CASH', 'UPI'] },
                paymentId: { $type: 'objectId' },
              },
              {
                kind: 'CREDIT',
                number: /^CRN-/,
                invoiceId: { $type: 'objectId' },
                paymentId: { $exists: false },
                method: { $exists: false },
                reference: { $exists: false },
              },
            ],
          },
          { $or: [{ method: { $ne: 'UPI' } }, { reference: { $type: 'string' } }] },
        ],
      },
      {
        model: 'RepairWarranty',
        required: ['jobId', 'invoiceId', 'days'],
        properties: { jobId: id, invoiceId: id, days: integer(1095), startsAt: date, endsAt: date },
        rules: [
          {
            $or: [
              { startsAt: { $exists: false }, endsAt: { $exists: false } },
              {
                startsAt: { $type: 'date' },
                endsAt: { $type: 'date' },
                $expr: {
                  $eq: ['$endsAt', { $add: ['$startsAt', { $multiply: ['$days', 86400000] }] }],
                },
              },
            ],
          },
        ],
      },
      {
        model: 'RepairBillingOperation',
        required: ['key', 'requestHash', 'kind', 'result', 'actorId'],
        properties: {
          key: text(100),
          requestHash: { ...text(64), pattern: '^[a-f0-9]{64}$' },
          kind: text(80),
          result: text(100),
          actorId: id,
        },
      },
      {
        model: 'RepairBillingSequence',
        required: ['key', 'value'],
        properties: { key: { enum: ['INV', 'RCP', 'REF', 'CRN'] }, value: integer(999999999, 1) },
      },
    ];
    for (const entry of definitions) {
      const model = connection.model(entry.model);
      if (!(await database.listCollections({ name: model.collection.name }).hasNext()))
        await model.createCollection();
      await model.createIndexes();
      await database.command({
        collMod: model.collection.name,
        validationLevel: 'strict',
        validationAction: 'error',
        validator: {
          $and: [
            {
              $jsonSchema: object([...entry.required, 'version', 'createdAt', 'updatedAt'], {
                ...common,
                ...entry.properties,
              }),
            },
            ...(entry.rules ?? []),
          ],
        },
      });
    }
    const jobInfo = await database
      .listCollections({ name: 'repair_jobs' }, { nameOnly: false })
      .next();
    const original = jobInfo?.options?.validator as Document | undefined;
    if (!original) throw new Error('Job validator unavailable');
    extendActions(original);
    const extra: Document = {
      $jsonSchema: object([], {
        warrantySourceJobNumber: jobNumber,
        warrantySourceInvoiceNumber: invoiceNumber,
        billingAuthorization: object(
          ['invoiceNumber', 'dueInPaise', 'authorizedBy', 'authorizedByName', 'at', 'reason'],
          {
            invoiceNumber,
            dueInPaise: money,
            authorizedBy: id,
            authorizedByName: text(120),
            at: date,
            reason: text(500, 3),
          },
        ),
      }),
    };
    const rules = [
      ...conjuncts(original),
      extra,
      {
        $or: [
          {
            warrantySourceJobNumber: { $exists: false },
            warrantySourceInvoiceNumber: { $exists: false },
          },
          {
            warrantySourceJobNumber: { $type: 'string' },
            warrantySourceInvoiceNumber: { $type: 'string' },
          },
        ],
      },
    ];
    await database.command({
      collMod: 'repair_jobs',
      validator: {
        $and: rules.filter(
          (rule, index) =>
            rules.findIndex((candidate) => isDeepStrictEqual(candidate, rule)) === index,
        ),
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await connection.model('RepairJob').createIndexes();
  },
};
