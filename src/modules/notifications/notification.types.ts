import type { NotificationChannel, NotificationStatus, OutboxStatus } from '../../domain/enums';

export interface RenderedEmail {
  templateKey: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendInput extends RenderedEmail {
  deliveryKey: string;
}

export interface EmailSendResult {
  messageId: string;
}

export interface RenderedMobileMessage {
  channel: NotificationChannel.Sms | NotificationChannel.WhatsApp;
  templateKey: string;
  recipient: string;
  text: string;
}

export interface MessageSendInput extends RenderedMobileMessage {
  deliveryKey: string;
}

export interface MessageSendResult {
  messageId: string;
}

export interface NotificationPageItem {
  id: string;
  sourceEventId: string;
  channel: NotificationChannel;
  templateKey: string;
  recipient: string;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: Date;
  providerMessageId?: string;
  sentAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationPage {
  items: NotificationPageItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface OutboxPageItem {
  id: string;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  status: OutboxStatus;
  processingAttempts: number;
  availableAt: Date;
  lockedAt?: Date;
  publishedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutboxPage {
  items: OutboxPageItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface NotificationOperationsSummary {
  outbox: Record<OutboxStatus, number>;
  notifications: Record<NotificationStatus, number>;
}
