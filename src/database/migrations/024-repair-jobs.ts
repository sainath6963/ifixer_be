import type { Document } from 'mongodb';
import { RepairJobStatus, repairTestKeys } from '../schemas/repair-job.schema';
import type { DatabaseMigration } from './migration';
const string = (maxLength: number, minLength = 1): Document => ({
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
const date = { bsonType: 'date' };
const id = { bsonType: 'objectId' };
const object = (required: string[], properties: Document): Document => ({
  bsonType: 'object',
  required,
  properties,
});
const status = { enum: Object.values(RepairJobStatus) };
const common = { createdAt: date, updatedAt: date, version: integer() };

export const repairJobsMigration: DatabaseMigration = {
  id: '024-repair-jobs',
  description:
    'Add private job cards, immutable estimate revisions, custody, intake photos and repair team roles',
  async up({ connection, database }): Promise<void> {
    // Preserve the installed identity/booking validators, extending only the new fields.
    const identity = await database.listCollections({ name: 'admin_users' }).next();
    const adminValidator = (
      identity && 'options' in identity ? identity.options?.validator : undefined
    ) as { $jsonSchema: { properties: { roles: { items: { enum: string[] } } } } } | undefined;
    if (!adminValidator?.$jsonSchema?.properties?.roles?.items)
      throw new Error('Admin validator is unavailable');
    adminValidator.$jsonSchema.properties.roles.items.enum = [
      'OWNER',
      'STAFF',
      'RECEPTION',
      'TECHNICIAN',
    ];
    await database.command({
      collMod: 'admin_users',
      validator: adminValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const booking = await database.listCollections({ name: 'repair_bookings' }).next();
    const bookingValidator = (
      booking && 'options' in booking ? booking.options?.validator : undefined
    ) as
      | {
          $and: Array<{
            $jsonSchema?: {
              properties: {
                jobNumber?: Document;
                history: { items: { properties: { action: { enum: string[] } } } };
              };
            };
          }>;
        }
      | undefined;
    const bookingProperties = bookingValidator?.$and.find((rule) => rule.$jsonSchema)?.$jsonSchema
      ?.properties;
    if (!bookingProperties) throw new Error('Booking validator is unavailable');
    bookingProperties.history.items.properties.action.enum = [
      'CREATE',
      'CONFIRM',
      'RESCHEDULE',
      'CANCEL',
      'CONVERT',
    ];
    bookingProperties.jobNumber = { ...string(20), pattern: '^JOB-[A-F0-9]{16}$' };
    await database.command({
      collMod: 'repair_bookings',
      validator: bookingValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    for (const name of ['RepairJob', 'RepairJobPhoto']) {
      const model = connection.model(name);
      if (!(await database.listCollections({ name: model.collection.name }).hasNext()))
        await model.createCollection();
      await model.createIndexes();
    }
    await database.command({
      collMod: 'repair_jobs',
      validationLevel: 'strict',
      validationAction: 'error',
      validator: {
        $and: [
          {
            $jsonSchema: object(
              [
                'number',
                'operationKey',
                'requestHash',
                'customerName',
                'phone',
                'deviceLabel',
                'issue',
                'condition',
                'accessories',
                'status',
                'custody',
                'estimates',
                'tests',
                'history',
                'photoCount',
                'createdAt',
                'updatedAt',
                'version',
              ],
              {
                ...common,
                number: { ...string(20), pattern: '^JOB-[A-F0-9]{16}$' },
                bookingId: id,
                bookingReference: { ...string(20), pattern: '^IFX-[A-F0-9]{16}$' },
                operationKey: string(100),
                requestHash: { ...string(64), pattern: '^[a-f0-9]{64}$' },
                customerId: id,
                customerName: string(120, 2),
                phone: { ...string(16), pattern: '^\\+?[1-9]\\d{7,14}$' },
                email: string(254),
                deviceLabel: string(400, 2),
                imei: { ...string(15), pattern: '^\\d{15}$' },
                serial: string(120),
                issue: string(2000, 10),
                condition: string(2000, 3),
                accessories: string(1000, 2),
                targetAt: date,
                technicianId: id,
                technicianName: string(120),
                status,
                custody: { enum: ['IN_SHOP', 'RETURNED'] },
                returnedAt: date,
                returnedTo: string(120, 2),
                diagnosis: string(2000, 3),
                photoCount: integer(8),
                estimates: {
                  bsonType: 'array',
                  maxItems: 100,
                  items: object(
                    ['revision', 'lines', 'totalInPaise', 'reason', 'at', 'createdBy'],
                    {
                      revision: integer(100, 1),
                      totalInPaise: integer(),
                      reason: string(1000, 3),
                      at: date,
                      createdBy: id,
                      lines: {
                        bsonType: 'array',
                        minItems: 1,
                        maxItems: 30,
                        items: object(['description', 'quantity', 'unitPriceInPaise'], {
                          description: string(160, 2),
                          quantity: integer(100, 1),
                          unitPriceInPaise: integer(),
                        }),
                      },
                      approval: object(
                        ['decision', 'method', 'customerName', 'evidence', 'at', 'recordedBy'],
                        {
                          decision: { enum: ['APPROVED', 'DECLINED'] },
                          method: { enum: ['IN_PERSON', 'PHONE', 'MESSAGE'] },
                          customerName: string(120, 2),
                          evidence: string(1000, 5),
                          at: date,
                          recordedBy: id,
                        },
                      ),
                    },
                  ),
                },
                tests: {
                  bsonType: 'array',
                  maxItems: 7,
                  items: object(['key', 'result'], {
                    key: { enum: [...repairTestKeys] },
                    result: { enum: ['PASS', 'FAIL', 'NA'] },
                    notes: string(500, 0),
                  }),
                },
                history: {
                  bsonType: 'array',
                  minItems: 1,
                  maxItems: 1000,
                  items: object(['at', 'actorId', 'actorName', 'action', 'status', 'reason'], {
                    at: date,
                    actorId: id,
                    actorName: string(120),
                    action: {
                      enum: [
                        'INTAKE',
                        'ASSIGN',
                        'DIAGNOSIS',
                        'NOTE',
                        'ESTIMATE',
                        'APPROVAL',
                        'TESTS',
                        'STATUS',
                        'RETURN_DEVICE',
                        'PHOTO',
                        'PHOTO_REMOVED',
                      ],
                    },
                    status,
                    reason: string(2000),
                  }),
                },
              },
            ),
          },
          {
            $or: [
              {
                custody: 'IN_SHOP',
                returnedAt: { $exists: false },
                returnedTo: { $exists: false },
                status: { $ne: 'DELIVERED' },
              },
              {
                custody: 'RETURNED',
                returnedAt: { $type: 'date' },
                returnedTo: { $type: 'string' },
                status: { $in: ['DELIVERED', 'CANCELLED', 'UNREPAIRABLE'] },
              },
            ],
          },
          {
            $expr: {
              $allElementsTrue: [
                {
                  $map: {
                    input: '$estimates',
                    as: 'estimate',
                    in: {
                      $eq: [
                        '$$estimate.totalInPaise',
                        {
                          $sum: {
                            $map: {
                              input: '$$estimate.lines',
                              as: 'line',
                              in: { $multiply: ['$$line.quantity', '$$line.unitPriceInPaise'] },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
          {
            $or: [
              { status: { $nin: ['REPAIRING', 'TESTING', 'READY', 'DELIVERED'] } },
              {
                $expr: {
                  $let: {
                    vars: { latest: { $arrayElemAt: ['$estimates', -1] } },
                    in: { $eq: ['$$latest.approval.decision', 'APPROVED'] },
                  },
                },
              },
            ],
          },
        ],
      },
    });
    await database.command({
      collMod: 'repair_job_photos',
      validationLevel: 'strict',
      validationAction: 'error',
      validator: {
        $jsonSchema: object(
          [
            'jobId',
            'checksum',
            'bytes',
            'sizeBytes',
            'width',
            'height',
            'uploadedBy',
            'createdAt',
            'updatedAt',
            'version',
          ],
          {
            ...common,
            jobId: id,
            checksum: { ...string(64), pattern: '^[a-f0-9]{64}$' },
            bytes: { bsonType: 'binData' },
            sizeBytes: integer(3145728, 1),
            width: integer(2000, 1),
            height: integer(2000, 1),
            uploadedBy: id,
          },
        ),
      },
    });
  },
};
