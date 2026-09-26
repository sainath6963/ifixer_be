import type { Document } from 'mongodb';

import type { DatabaseMigration } from './migration';

function addExpiredReturnStatus(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) addExpiredReturnStatus(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const document = value as Record<string, unknown>;
  if (
    Array.isArray(document.enum) &&
    document.enum.includes('REQUESTED') &&
    document.enum.includes('COMPLETED') &&
    !document.enum.includes('EXPIRED')
  ) {
    document.enum.push('EXPIRED');
  }
  for (const child of Object.values(document)) addExpiredReturnStatus(child);
}

export const exchangeStockReservationsMigration: DatabaseMigration = {
  id: '015-exchange-stock-reservations',
  description: 'Reserve, expire, and commit replacement inventory for approved exchanges',
  async up(context): Promise<void> {
    await context.connection.model('ReturnRequest').createIndexes();
    await context.connection.model('InventoryReservation').createIndexes();
    await context.connection.model('InventoryMovement').createIndexes();

    const returnInfo = await context.database
      .listCollections({ name: 'return_requests' }, { nameOnly: false })
      .next();
    const returnValidator = (returnInfo?.options?.validator ?? {}) as Document;
    addExpiredReturnStatus(returnValidator);
    await context.database.command({
      collMod: 'return_requests',
      validator: {
        $and: [
          returnValidator,
          {
            $jsonSchema: {
              bsonType: 'object',
              properties: {
                exchangeReservationStatus: { enum: ['ACTIVE', 'COMMITTED', 'EXPIRED'] },
                exchangeReservationExpiresAt: { bsonType: 'date' },
                exchangeReservationFinalizedAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $or: [
                { $eq: [{ $type: '$exchangeReservationStatus' }, 'missing'] },
                {
                  $and: [
                    { $eq: ['$type', 'EXCHANGE'] },
                    {
                      $or: [
                        {
                          $and: [
                            { $eq: ['$exchangeReservationStatus', 'ACTIVE'] },
                            { $in: ['$status', ['APPROVED', 'RECEIVED']] },
                            { $eq: [{ $type: '$exchangeReservationExpiresAt' }, 'date'] },
                            {
                              $eq: [{ $type: '$exchangeReservationFinalizedAt' }, 'missing'],
                            },
                          ],
                        },
                        {
                          $and: [
                            { $eq: ['$exchangeReservationStatus', 'COMMITTED'] },
                            { $eq: ['$status', 'COMPLETED'] },
                            {
                              $eq: [{ $type: '$exchangeReservationFinalizedAt' }, 'date'],
                            },
                          ],
                        },
                        {
                          $and: [
                            { $eq: ['$exchangeReservationStatus', 'EXPIRED'] },
                            { $eq: ['$status', 'EXPIRED'] },
                            {
                              $eq: [{ $type: '$exchangeReservationFinalizedAt' }, 'date'],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    const reservationInfo = await context.database
      .listCollections({ name: 'inventory_reservations' }, { nameOnly: false })
      .next();
    const reservationValidator = (reservationInfo?.options?.validator ?? {}) as Document;
    await context.database.command({
      collMod: 'inventory_reservations',
      validator: {
        $and: [
          reservationValidator,
          {
            $jsonSchema: {
              bsonType: 'object',
              properties: {
                orderId: { bsonType: 'objectId' },
                returnRequestId: { bsonType: 'objectId' },
              },
            },
          },
          {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: [{ $type: '$orderId' }, 'objectId'] },
                    { $eq: [{ $type: '$returnRequestId' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: [{ $type: '$returnRequestId' }, 'objectId'] },
                    { $eq: [{ $type: '$orderId' }, 'missing'] },
                    {
                      $regexMatch: {
                        input: '$reservationGroupId',
                        regex: '^exchange:[a-f0-9]{24}$',
                      },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
