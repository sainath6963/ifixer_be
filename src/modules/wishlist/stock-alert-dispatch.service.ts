import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { OutboxEvent } from '../../database/schemas/integration.schema';
import { StockAlert } from '../../database/schemas/wishlist.schema';
import { OutboxStatus, StockAlertStatus } from '../../domain/enums';

const STOCK_ALERT_DISPATCH_BATCH = 100;

@Injectable()
export class StockAlertDispatchService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(StockAlert.name) private readonly alerts: Model<StockAlert>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
  ) {}

  async processBatch(): Promise<{ available: number; dispatched: number }> {
    const available = await this.availableAlertIds();
    let dispatched = 0;
    for (const id of available) {
      if (await this.dispatch(id)) dispatched += 1;
    }
    return { available: available.length, dispatched };
  }

  private async availableAlertIds(): Promise<Types.ObjectId[]> {
    const rows = await this.alerts
      .aggregate<{ _id: Types.ObjectId }>([
        { $match: { active: true, status: StockAlertStatus.Active } },
        {
          $lookup: {
            from: 'inventory_levels',
            let: { alertVariantId: '$variantId' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$variantId', '$$alertVariantId'] },
                      { $gt: ['$onHand', '$reserved'] },
                    ],
                  },
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: 'availableInventory',
          },
        },
        { $match: { 'availableInventory.0': { $exists: true } } },
        { $sort: { requestedAt: 1, _id: 1 } },
        { $limit: STOCK_ALERT_DISPATCH_BATCH },
        { $project: { _id: 1 } },
      ])
      .exec();
    return rows.map((row) => row._id);
  }

  private async dispatch(id: Types.ObjectId): Promise<boolean> {
    return this.connection.transaction(async (session): Promise<boolean> => {
      const alert = await this.alerts
        .findOneAndUpdate(
          { _id: id, active: true, status: StockAlertStatus.Active },
          {
            $set: {
              active: false,
              status: StockAlertStatus.Notified,
              notifiedAt: new Date(),
            },
            $inc: { version: 1 },
          },
          { session, returnDocument: 'after', runValidators: true },
        )
        .exec();
      if (!alert) return false;
      const eventId = `stock-alert:${alert.id}`;
      await this.outbox.updateOne(
        { eventId },
        {
          $setOnInsert: {
            eventId,
            aggregateType: 'STOCK_ALERT',
            aggregateId: alert._id,
            eventType: 'STOCK_ALERT_AVAILABLE',
            payload: {
              customerId: alert.customerId.toHexString(),
              productId: alert.productId.toHexString(),
              variantId: alert.variantId.toHexString(),
              productName: alert.productName,
              productSlug: alert.productSlug,
              variantTitle: alert.variantTitle,
              sku: alert.sku,
            },
            status: OutboxStatus.Pending,
            processingAttempts: 0,
            availableAt: new Date(),
          },
        },
        { upsert: true, session },
      );
      return true;
    });
  }
}
