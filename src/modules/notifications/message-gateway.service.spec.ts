import { ConfigService } from '@nestjs/config';

import { NotificationChannel } from '../../domain/enums';
import { MessageGatewayService } from './message-gateway.service';

const deliveryKey = 'a'.repeat(64);

function config(overrides: Record<string, unknown> = {}): ConfigService {
  return new ConfigService({
    MESSAGE_DELIVERY_MODE: 'log',
    MESSAGE_PROVIDER_URL: '',
    MESSAGE_PROVIDER_TOKEN: '',
    MESSAGE_PROVIDER_TIMEOUT_MS: 5000,
    SMS_DELIVERY_ENABLED: true,
    WHATSAPP_DELIVERY_ENABLED: false,
    SMS_SENDER: '',
    WHATSAPP_SENDER: '',
    ...overrides,
  });
}

describe('MessageGatewayService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a deterministic id in safe log mode', async () => {
    const gateway = new MessageGatewayService(config());

    await expect(
      gateway.send({
        channel: NotificationChannel.Sms,
        templateKey: 'CUSTOMER_MOBILE_OTP_REQUESTED',
        recipient: '+919876543210',
        text: 'sensitive message',
        deliveryKey,
      }),
    ).resolves.toEqual({ messageId: `log-${deliveryKey}` });
  });

  it('sends the provider adapter an idempotent authenticated request', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messageId: 'provider-message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const gateway = new MessageGatewayService(
      config({
        MESSAGE_DELIVERY_MODE: 'http',
        MESSAGE_PROVIDER_URL: 'https://messages.example.test/v1/send',
        MESSAGE_PROVIDER_TOKEN: 'provider-secret-token',
        SMS_SENDER: 'RICHCULTURE',
      }),
    );

    await expect(
      gateway.send({
        channel: NotificationChannel.Sms,
        templateKey: 'ORDER_PAYMENT_CAPTURED',
        recipient: '+919876543210',
        text: 'Order confirmed',
        deliveryKey,
      }),
    ).resolves.toEqual({ messageId: 'provider-message-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://messages.example.test/v1/send');
    expect(request?.method).toBe('POST');
    const headers = new Headers(request?.headers);
    expect(headers.get('Authorization')).toBe('Bearer provider-secret-token');
    expect(headers.get('Idempotency-Key')).toBe(deliveryKey);
  });

  it('fails closed when a channel is disabled', async () => {
    const gateway = new MessageGatewayService(config({ SMS_DELIVERY_ENABLED: false }));

    await expect(
      gateway.send({
        channel: NotificationChannel.Sms,
        templateKey: 'ORDER_PAYMENT_CAPTURED',
        recipient: '+919876543210',
        text: 'Order confirmed',
        deliveryKey,
      }),
    ).rejects.toThrow('SMS delivery is disabled');
  });
});
