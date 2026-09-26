import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Customer,
  CustomerDocument,
  CustomerMobileChallenge,
} from '../../database/schemas/identity.schema';
import { OutboxEventDocument } from '../../database/schemas/integration.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import { ReturnRequest } from '../../database/schemas/return-request.schema';
import { AccountStatus, NotificationChannel } from '../../domain/enums';
import { decryptCustomerMobileOtp } from '../customer/customer-otp-envelope';
import type { RenderedMobileMessage } from './notification.types';

const ORDER_EVENTS = new Set([
  'ORDER_PAYMENT_CAPTURED',
  'ORDER_SHIPMENT_CREATED',
  'ORDER_FULFILLMENT_SHIPPED',
  'ORDER_SHIPMENT_OUT_FOR_DELIVERY',
  'ORDER_SHIPMENT_DELIVERY_EXCEPTION',
  'ORDER_FULFILLMENT_DELIVERED',
  'ORDER_REFUND_SUCCEEDED',
]);

const RETURN_EVENTS = new Set([
  'RETURN_REQUEST_REQUESTED',
  'RETURN_REQUEST_APPROVED',
  'RETURN_REQUEST_REJECTED',
  'RETURN_REQUEST_CANCELLED',
  'RETURN_REQUEST_RECEIVED',
  'RETURN_REQUEST_COMPLETED',
  'RETURN_REQUEST_EXPIRED',
]);

@Injectable()
export class MobileNotificationTemplateService {
  private readonly smsEnabled: boolean;
  private readonly whatsappEnabled: boolean;
  private readonly otpSecret: string;

  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerMobileChallenge.name)
    private readonly mobileChallenges: Model<CustomerMobileChallenge>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(ReturnRequest.name) private readonly returnRequests: Model<ReturnRequest>,
    config: ConfigService,
  ) {
    this.smsEnabled = config.getOrThrow<boolean>('SMS_DELIVERY_ENABLED');
    this.whatsappEnabled = config.getOrThrow<boolean>('WHATSAPP_DELIVERY_ENABLED');
    this.otpSecret = config.getOrThrow<string>('CUSTOMER_TOKEN_PEPPER');
  }

  async render(event: OutboxEventDocument): Promise<RenderedMobileMessage[]> {
    if (event.eventType === 'CUSTOMER_MOBILE_OTP_REQUESTED') {
      const otp = await this.renderOtp(event);
      return otp ? [otp] : [];
    }
    if (RETURN_EVENTS.has(event.eventType)) return this.renderReturn(event);
    if (ORDER_EVENTS.has(event.eventType)) return this.renderOrder(event);
    return [];
  }

  private async renderOtp(event: OutboxEventDocument): Promise<RenderedMobileMessage | null> {
    if (!this.smsEnabled || event.aggregateType !== 'CUSTOMER_MOBILE_CHALLENGE') return null;
    const challenge = await this.mobileChallenges
      .findOne({ _id: event.aggregateId, active: true, expiresAt: { $gt: new Date() } })
      .exec();
    if (!challenge) return null;
    const otp = decryptCustomerMobileOtp(event.payload.otpEnvelope, this.otpSecret);
    if (!otp) throw new Error('Mobile verification payload is invalid');
    const expiresInMinutes = Math.max(
      1,
      Math.ceil((challenge.expiresAt.getTime() - Date.now()) / 60_000),
    );
    return {
      channel: NotificationChannel.Sms,
      templateKey: event.eventType,
      recipient: challenge.targetMobile,
      text: `Your Rich Culture verification code is ${otp}. It expires in ${expiresInMinutes} minutes. Do not share this code.`,
    };
  }

  private async renderOrder(event: OutboxEventDocument): Promise<RenderedMobileMessage[]> {
    const order = await this.resolveOrder(event);
    if (!order?.customerId) return [];
    const customer = await this.eligibleCustomer(order.customerId);
    if (!customer) return [];
    return this.customerMessages(customer, event.eventType, this.orderText(event, order));
  }

  private async renderReturn(event: OutboxEventDocument): Promise<RenderedMobileMessage[]> {
    if (event.aggregateType !== 'RETURN_REQUEST') return [];
    const request = await this.returnRequests.findById(event.aggregateId).exec();
    if (!request) throw new Error('Notification source return request was not found');
    const customer = await this.eligibleCustomer(request.customerId);
    if (!customer) return [];
    const returnNumber = this.payloadString(event, 'returnNumber');
    const orderNumber = this.payloadString(event, 'orderNumber');
    const status = event.eventType
      .replace('RETURN_REQUEST_', '')
      .replaceAll('_', ' ')
      .toLowerCase();
    const text = `Rich Culture: ${returnNumber} for order ${orderNumber} is ${status}. View your account for details.`;
    return this.customerMessages(customer, event.eventType, text);
  }

  private async resolveOrder(event: OutboxEventDocument): Promise<OrderDocument | null> {
    if (event.aggregateType === 'ORDER') return this.orders.findById(event.aggregateId).exec();
    const orderId = event.payload.orderId;
    if (typeof orderId !== 'string' || !Types.ObjectId.isValid(orderId)) {
      throw new Error('Notification source order is invalid');
    }
    return this.orders.findById(orderId).exec();
  }

  private eligibleCustomer(customerId: Types.ObjectId): Promise<CustomerDocument | null> {
    return this.customers
      .findOne({
        _id: customerId,
        status: AccountStatus.Active,
        mobile: { $type: 'string' },
        mobileVerifiedAt: { $type: 'date' },
      })
      .exec();
  }

  private customerMessages(
    customer: CustomerDocument,
    templateKey: string,
    text: string,
  ): RenderedMobileMessage[] {
    if (!customer.mobile) return [];
    const messages: RenderedMobileMessage[] = [];
    if (this.smsEnabled && customer.communicationPreferences?.orderUpdatesSms === true) {
      messages.push({
        channel: NotificationChannel.Sms,
        templateKey,
        recipient: customer.mobile,
        text,
      });
    }
    if (this.whatsappEnabled && customer.communicationPreferences?.orderUpdatesWhatsapp === true) {
      messages.push({
        channel: NotificationChannel.WhatsApp,
        templateKey,
        recipient: customer.mobile,
        text,
      });
    }
    return messages;
  }

  private orderText(event: OutboxEventDocument, order: OrderDocument): string {
    const prefix = `Rich Culture: order ${order.orderNumber}`;
    switch (event.eventType) {
      case 'ORDER_PAYMENT_CAPTURED':
        return `${prefix} is confirmed. Payment received.`;
      case 'ORDER_SHIPMENT_CREATED':
        return `${prefix} is packed and ready to ship.`;
      case 'ORDER_FULFILLMENT_SHIPPED':
        return `${prefix} has shipped via ${order.shipping?.courierName || 'our courier'}.${this.trackingSuffix(order)}`;
      case 'ORDER_SHIPMENT_OUT_FOR_DELIVERY':
        return `${prefix} is out for delivery today.${this.trackingSuffix(order)}`;
      case 'ORDER_SHIPMENT_DELIVERY_EXCEPTION':
        return `${prefix} has a delivery exception. Check tracking or contact support.${this.trackingSuffix(order)}`;
      case 'ORDER_FULFILLMENT_DELIVERED':
        return `${prefix} was delivered.`;
      case 'ORDER_REFUND_SUCCEEDED':
        return `${prefix} refund was processed. Your bank may take additional time to show the credit.`;
      default:
        throw new Error('Unsupported mobile order notification template');
    }
  }

  private trackingSuffix(order: OrderDocument): string {
    return order.shipping?.trackingNumber ? ` Tracking: ${order.shipping.trackingNumber}.` : '';
  }

  private payloadString(event: OutboxEventDocument, key: string): string {
    const value = event.payload[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Notification event ${key} is invalid`);
    }
    return value.trim();
  }
}
