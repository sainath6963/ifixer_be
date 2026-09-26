import { Model, Types } from 'mongoose';

import { Notification, NotificationDocument } from '../../database/schemas/notification.schema';
import { NotificationChannel, NotificationStatus } from '../../domain/enums';
import { EmailGatewayService } from './email-gateway.service';
import { MessageGatewayService } from './message-gateway.service';
import { NotificationDeliveryService } from './notification-delivery.service';

describe('NotificationDeliveryService', () => {
  it.each([
    'CUSTOMER_EMAIL_VERIFICATION_REQUESTED',
    'CUSTOMER_EMAIL_CHANGE_REQUESTED',
    'CUSTOMER_PASSWORD_RESET_REQUESTED',
  ])('removes a sensitive %s link after successful delivery', async (templateKey) => {
    const notification = {
      _id: new Types.ObjectId(),
      templateKey,
      channel: NotificationChannel.Email,
      recipient: 'customer@example.com',
      subject: 'Reset password',
      textBody: 'https://shop.example/reset-password?token=secret',
      htmlBody: '<a href="https://shop.example/reset-password?token=secret">Reset</a>',
      deliveryKey: 'a'.repeat(64),
      status: NotificationStatus.Processing,
      lockToken: 'lease-token',
    } as NotificationDocument;
    const claimExec = jest.fn().mockResolvedValueOnce(notification).mockResolvedValueOnce(null);
    const updates: unknown[] = [];
    const updateOne = jest.fn(
      (_filter: unknown, update: unknown): Promise<{ modifiedCount: number }> => {
        updates.push(update);
        return Promise.resolve({ modifiedCount: 1 });
      },
    );
    const model = {
      findOneAndUpdate: jest.fn(() => ({ exec: claimExec })),
      updateOne,
    } as unknown as Model<Notification>;
    const email = {
      send: jest.fn().mockResolvedValue({ messageId: '<message@example.com>' }),
    } as unknown as EmailGatewayService;
    const messages = { send: jest.fn() } as unknown as MessageGatewayService;
    const service = new NotificationDeliveryService(model, email, messages);

    await expect(service.processBatch()).resolves.toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(updateOne).toHaveBeenCalledTimes(1);
    const savedUpdate = updates[0];
    if (!savedUpdate || typeof savedUpdate !== 'object') throw new Error('Expected update');
    expect((savedUpdate as Record<string, unknown>).$set).toMatchObject({
      status: NotificationStatus.Sent,
      textBody: '[Sensitive one-time credential removed after delivery]',
      htmlBody: '<p>Sensitive one-time credential removed after delivery.</p>',
    });
  });
});
