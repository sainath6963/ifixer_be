import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';

import type { EmailSendInput, EmailSendResult } from './notification.types';

@Injectable()
export class EmailGatewayService implements OnApplicationShutdown {
  private readonly logger = new Logger(EmailGatewayService.name);
  private readonly mode: 'log' | 'smtp';
  private readonly transporter?: Transporter<SMTPPool.SentMessageInfo, SMTPPool.Options>;
  private readonly fromName: string;
  private readonly fromAddress: string;

  constructor(private readonly config: ConfigService) {
    this.mode = this.config.getOrThrow<'log' | 'smtp'>('EMAIL_DELIVERY_MODE');
    this.fromName = this.config.getOrThrow<string>('EMAIL_FROM_NAME');
    this.fromAddress = this.config.getOrThrow<string>('EMAIL_FROM_ADDRESS');
    if (this.mode === 'smtp') {
      const username = this.config.getOrThrow<string>('SMTP_USERNAME');
      const password = this.config.getOrThrow<string>('SMTP_PASSWORD');
      this.transporter = nodemailer.createTransport({
        pool: true,
        host: this.config.getOrThrow<string>('SMTP_HOST'),
        port: this.config.getOrThrow<number>('SMTP_PORT'),
        secure: this.config.getOrThrow<boolean>('SMTP_SECURE'),
        requireTLS: this.config.getOrThrow<boolean>('SMTP_REQUIRE_TLS'),
        auth: username ? { user: username, pass: password } : undefined,
        connectionTimeout: this.config.getOrThrow<number>('SMTP_CONNECTION_TIMEOUT_MS'),
        greetingTimeout: this.config.getOrThrow<number>('SMTP_CONNECTION_TIMEOUT_MS'),
        socketTimeout: 30_000,
        maxConnections: this.config.getOrThrow<number>('SMTP_MAX_CONNECTIONS'),
        maxMessages: 100,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    }
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const messageId = this.messageId(input.deliveryKey);
    if (!this.transporter) {
      this.logger.log(
        `Email delivery simulated deliveryKey=${input.deliveryKey} template=${input.templateKey}`,
      );
      return { messageId };
    }

    try {
      const response = await this.transporter.sendMail({
        from: { name: this.fromName, address: this.fromAddress },
        to: input.recipient,
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId,
        headers: { 'X-Rich-Culture-Delivery-Key': input.deliveryKey },
      });
      return { messageId: response.messageId || messageId };
    } catch {
      throw new Error('SMTP delivery failed');
    }
  }

  onApplicationShutdown(): void {
    this.transporter?.close();
  }

  private messageId(deliveryKey: string): string {
    const domain = this.fromAddress.split('@')[1] || 'notifications.local';
    return `<${deliveryKey}@${domain}>`;
  }
}
