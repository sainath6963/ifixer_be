import type { Document } from 'mongodb';
import type { DatabaseMigration } from './migration';

const text = (maxLength: number, minLength = 1): Document => ({
  bsonType: 'string',
  minLength,
  maxLength,
});
const objectId = { bsonType: 'objectId' };
const number = { bsonType: 'number', minimum: 0, maximum: 1000000000 };
const integer = (field: string): Document => ({ $eq: [{ $trunc: field }, field] });
const common: Document = {
  active: { bsonType: 'bool' },
  sortOrder: number,
  version: number,
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
};
const named: Document = {
  name: text(120),
  slug: { ...text(160), pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
};
const price: Document = {
  pricingMode: { enum: ['DIAGNOSIS', 'INDICATIVE'] },
  priceInPaise: number,
};
const priceRule = (field: string): Document => ({
  $or: [
    { pricingMode: 'DIAGNOSIS', [field]: { $exists: false } },
    { pricingMode: 'INDICATIVE', [field]: { $type: 'number' }, $expr: integer(`$${field}`) },
  ],
});
const status = ['REQUESTED', 'CONFIRMED', 'CANCELLED', 'CONVERTED'];

export const repairCatalogBookingsMigration: DatabaseMigration = {
  id: '023-repair-catalog-bookings',
  description:
    'Add repair catalog, compatibility, private bookings, versioned visit changes and duplicate request protection',
  async up(context) {
    const definitions: Array<{
      collection: string;
      model: string;
      required: string[];
      properties: Document;
      rules?: Document[];
    }> = [
      {
        collection: 'device_brands',
        model: 'DeviceBrand',
        required: ['name', 'slug'],
        properties: named,
      },
      {
        collection: 'device_models',
        model: 'DeviceModel',
        required: ['name', 'slug', 'brandId'],
        properties: { ...named, brandId: objectId },
      },
      {
        collection: 'repair_services',
        model: 'RepairService',
        required: ['name', 'slug', 'description', 'pricingMode'],
        properties: { ...named, ...price, description: text(1200) },
        rules: [priceRule('priceInPaise')],
      },
      {
        collection: 'repair_service_options',
        model: 'RepairServiceOption',
        required: ['modelId', 'serviceId', 'pricingMode'],
        properties: { ...price, modelId: objectId, serviceId: objectId },
        rules: [priceRule('priceInPaise')],
      },
    ];
    for (const item of definitions) {
      if (!(await context.database.listCollections({ name: item.collection }).hasNext()))
        await context.connection.model(item.model).createCollection();
      await context.connection.model(item.model).createIndexes();
      await context.database.command({
        collMod: item.collection,
        validator: {
          $and: [
            {
              $jsonSchema: {
                bsonType: 'object',
                required: [
                  'active',
                  'sortOrder',
                  'version',
                  'createdAt',
                  'updatedAt',
                  ...item.required,
                ],
                properties: { ...common, ...item.properties },
              },
            },
            { $expr: { $and: [integer('$sortOrder'), integer('$version')] } },
            ...(item.rules ?? []),
          ],
        },
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
    if (!(await context.database.listCollections({ name: 'repair_bookings' }).hasNext()))
      await context.connection.model('RepairBooking').createCollection();
    await context.connection.model('RepairBooking').createIndexes();
    await context.database.command({
      collMod: 'repair_bookings',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'reference',
                'operationKey',
                'requestHash',
                'manageTokenHash',
                'source',
                'customerName',
                'phone',
                'deviceLabel',
                'serviceLabel',
                'issue',
                'pricingMode',
                'status',
                'history',
                'version',
                'createdAt',
                'updatedAt',
              ],
              properties: {
                reference: { ...text(20), pattern: '^IFX-[A-F0-9]{16}$' },
                operationKey: text(100),
                requestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                manageTokenHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                customerId: objectId,
                source: { enum: ['ONLINE', 'WALK_IN'] },
                customerName: text(120, 2),
                phone: { ...text(16), pattern: '^\\+?[1-9]\\d{7,14}$' },
                email: text(254),
                brandId: objectId,
                modelId: objectId,
                serviceId: objectId,
                deviceLabel: text(400),
                serviceLabel: text(160),
                issue: text(2000, 10),
                pricingMode: { enum: ['DIAGNOSIS', 'INDICATIVE'] },
                indicativePriceInPaise: number,
                requestedVisitAt: { bsonType: 'date' },
                confirmedVisitAt: { bsonType: 'date' },
                status: { enum: status },
                version: number,
                createdAt: { bsonType: 'date' },
                updatedAt: { bsonType: 'date' },
                history: {
                  bsonType: 'array',
                  minItems: 1,
                  items: {
                    bsonType: 'object',
                    required: ['at', 'actor', 'action', 'status', 'reason'],
                    properties: {
                      at: { bsonType: 'date' },
                      actor: { enum: ['ADMIN', 'CUSTOMER', 'GUEST'] },
                      actorId: objectId,
                      action: { enum: ['CREATE', 'CONFIRM', 'RESCHEDULE', 'CANCEL'] },
                      status: { enum: status },
                      reason: text(500),
                      visitAt: { bsonType: 'date' },
                    },
                  },
                },
              },
            },
          },
          { $expr: integer('$version') },
          priceRule('indicativePriceInPaise'),
          {
            $or: [
              { status: 'CONFIRMED', confirmedVisitAt: { $type: 'date' } },
              { status: { $in: ['REQUESTED', 'CANCELLED'] }, confirmedVisitAt: { $exists: false } },
              { status: 'CONVERTED' },
            ],
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
