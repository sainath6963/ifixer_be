import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationChannel } from '../../domain/enums';
import type { MessageSendInput, MessageSendResult } from './notification.types';

interface ProviderResponse {
  messageId?: unknown;
}

@Injectable()
export class MessageGatewayService {
  private readonly logger = new Logger(MessageGatewayService.name);
  private readonly mode: 'log' | 'http';
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly smsSender: string;
  private readonly whatsappSender: string;

  constructor(private readonly config: ConfigService) {
    this.mode = config.getOrThrow<'log' | 'http'>('MESSAGE_DELIVERY_MODE');
    this.endpoint = config.getOrThrow<string>('MESSAGE_PROVIDER_URL');
    this.token = config.getOrThrow<string>('MESSAGE_PROVIDER_TOKEN');
    this.timeoutMs = config.getOrThrow<number>('MESSAGE_PROVIDER_TIMEOUT_MS');
    this.smsSender = config.getOrThrow<string>('SMS_SENDER');
    this.whatsappSender = config.getOrThrow<string>('WHATSAPP_SENDER');
  }

  isEnabled(channel: NotificationChannel.Sms | NotificationChannel.WhatsApp): boolean {
    return this.config.getOrThrow<boolean>(
      channel === NotificationChannel.Sms ? 'SMS_DELIVERY_ENABLED' : 'WHATSAPP_DELIVERY_ENABLED',
    );
  }

  async send(input: MessageSendInput): Promise<MessageSendResult> {
    if (!this.isEnabled(input.channel)) {
      throw new Error(`${input.channel} delivery is disabled`);
    }
    if (this.mode === 'log') {
      this.logger.log(
        `Mobile delivery simulated deliveryKey=${input.deliveryKey} channel=${input.channel} template=${input.templateKey}`,
      );
      return { messageId: `log-${input.deliveryKey}` };
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.deliveryKey,
        },
        body: JSON.stringify({
          channel: input.channel,
          recipient: input.recipient,
          sender: input.channel === NotificationChannel.Sms ? this.smsSender : this.whatsappSender,
          templateKey: input.templateKey,
          text: input.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error('Message provider rejected the request');
      const payload = (await response.json()) as ProviderResponse;
      if (typeof payload.messageId !== 'string' || !payload.messageId.trim()) {
        throw new Error('Message provider returned an invalid response');
      }
      return { messageId: payload.messageId.trim().slice(0, 500) };
    } catch {
      throw new Error('Mobile message delivery failed');
    }
  }
}
