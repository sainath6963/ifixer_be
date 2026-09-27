import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Model, Types } from 'mongoose';

import {
  Customer,
  CustomerActionToken,
  CustomerActionTokenDocument,
} from '../../database/schemas/identity.schema';
import { OutboxEventDocument } from '../../database/schemas/integration.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import { Refund, RefundDocument } from '../../database/schemas/payment.schema';
import { ReturnRequest } from '../../database/schemas/return-request.schema';
import {
  AccountStatus,
  CustomerActionPurpose,
  ReturnRequestType,
  ReturnResolutionType,
} from '../../domain/enums';
import { decryptCustomerActionToken } from '../customer/customer-action-token-envelope';
import type { RenderedEmail } from './notification.types';

const CUSTOMER_EVENTS = new Set([
  'ORDER_PAYMENT_CAPTURED',
  'ORDER_FULFILLMENT_SHIPPED',
  'ORDER_FULFILLMENT_DELIVERED',
  'ORDER_REFUND_SUCCEEDED',
]);
const OPERATIONS_EVENTS = new Set(['ORDER_LATE_PAYMENT_CAPTURED', 'ORDER_REFUND_FAILED']);
const CUSTOMER_AUTH_EVENTS = new Set([
  'CUSTOMER_EMAIL_VERIFICATION_REQUESTED',
  'CUSTOMER_EMAIL_CHANGE_REQUESTED',
  'CUSTOMER_PASSWORD_RESET_REQUESTED',
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
const STOCK_ALERT_EVENTS = new Set(['STOCK_ALERT_AVAILABLE']);

@Injectable()
export class NotificationTemplateService {
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(ReturnRequest.name) private readonly returnRequests: Model<ReturnRequest>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerActionToken.name)
    private readonly customerActionTokens: Model<CustomerActionToken>,
    private readonly config: ConfigService,
  ) {}

  async render(event: OutboxEventDocument): Promise<RenderedEmail[]> {
    if (STOCK_ALERT_EVENTS.has(event.eventType)) {
      const stockAlertEmail = await this.renderStockAlert(event);
      return stockAlertEmail ? [stockAlertEmail] : [];
    }
    if (CUSTOMER_AUTH_EVENTS.has(event.eventType)) {
      const actionEmail = await this.renderCustomerAction(event);
      return actionEmail ? [actionEmail] : [];
    }
    if (RETURN_EVENTS.has(event.eventType)) return this.renderReturnLifecycle(event);
    if (!CUSTOMER_EVENTS.has(event.eventType) && !OPERATIONS_EVENTS.has(event.eventType)) return [];

    const refund =
      event.aggregateType === 'REFUND' ? await this.refunds.findById(event.aggregateId) : null;
    const order = await this.resolveOrder(event, refund);
    if (!order) throw new Error('Notification source order was not found');

    if (OPERATIONS_EVENTS.has(event.eventType)) {
      return this.operationsRecipients().map((recipient) =>
        this.renderOperations(event.eventType, recipient, order, refund),
      );
    }
    if (!order.customer.email) return [];
    return [this.renderCustomer(event.eventType, order.customer.email, order, refund)];
  }

  private async renderStockAlert(event: OutboxEventDocument): Promise<RenderedEmail | null> {
    if (event.aggregateType !== 'STOCK_ALERT') return null;
    const customerId = this.stockPayloadString(event, 'customerId');
    if (!Types.ObjectId.isValid(customerId)) throw new Error('Stock alert customer is invalid');
    const customer = await this.customers
      .findOne({
        _id: new Types.ObjectId(customerId),
        status: AccountStatus.Active,
        emailVerifiedAt: { $type: 'date' },
        'communicationPreferences.backInStockEmail': true,
      })
      .exec();
    if (!customer?.email) return null;
    const productName = this.stockPayloadString(event, 'productName');
    const productSlug = this.stockPayloadString(event, 'productSlug');
    const variantTitle = this.stockPayloadString(event, 'variantTitle');
    const productUrl = new URL(
      `/products/${encodeURIComponent(productSlug)}`,
      this.config.getOrThrow<string>('PUBLIC_STOREFRONT_URL'),
    ).toString();
    const name = customer.name?.trim() || 'there';
    const detail = `${productName} in ${variantTitle} is available again. Stock can move quickly and is not reserved by this alert.`;
    const text = `Hello ${name},\n\nBack in stock\n\n${detail}\n\n${productUrl}\n\niFixer`;
    const html = `<!doctype html><html><body><p>Hello ${this.escape(name)},</p><h1>Back in stock</h1><p>${this.escape(detail)}</p><p><a href="${this.escape(productUrl)}">View ${this.escape(productName)}</a></p><p>iFixer</p></body></html>`;
    return {
      templateKey: event.eventType,
      recipient: customer.email.trim().toLowerCase(),
      subject: `${productName} is back in stock`,
      text,
      html,
    };
  }

  private stockPayloadString(event: OutboxEventDocument, key: string): string {
    const value = event.payload[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Stock alert event ${key} is invalid`);
    }
    return value.trim();
  }

  private async renderReturnLifecycle(event: OutboxEventDocument): Promise<RenderedEmail[]> {
    if (event.aggregateType !== 'RETURN_REQUEST') return [];
    const request = await this.returnRequests.findById(event.aggregateId).exec();
    if (!request) throw new Error('Notification source return request was not found');
    const order = await this.orders.findById(request.orderId).exec();
    if (!order) throw new Error('Notification source order was not found');

    const emails: RenderedEmail[] = [];
    if (order.customer.email) {
      emails.push(
        this.renderReturnCustomer(
          event,
          order.customer.email,
          order.customer.name?.trim() || order.shippingAddress.fullName,
        ),
      );
    }
    if (event.eventType === 'RETURN_REQUEST_REQUESTED') {
      emails.push(
        ...this.operationsRecipients().map((recipient) =>
          this.email(
            'RETURN_REQUEST_REQUESTED_OPERATIONS',
            recipient,
            `New ${this.returnType(event)} request ${this.payloadString(event, 'returnNumber')}`,
            'Operations team',
            'New return request needs review',
            `${this.payloadString(event, 'returnNumber')} was opened for order ${this.payloadString(event, 'orderNumber')} with ${this.payloadNumber(event, 'itemCount')} item line(s).`,
          ),
        ),
      );
    }
    return emails;
  }

  private renderReturnCustomer(
    event: OutboxEventDocument,
    recipient: string,
    name: string,
  ): RenderedEmail {
    const returnNumber = this.payloadString(event, 'returnNumber');
    const orderNumber = this.payloadString(event, 'orderNumber');
    const customerMessage = this.payloadOptionalString(event, 'customerMessage');
    const messageSuffix = customerMessage ? ` Message from our team: ${customerMessage}` : '';
    let subject: string;
    let heading: string;
    let detail: string;

    switch (event.eventType) {
      case 'RETURN_REQUEST_REQUESTED':
        subject = `We received request ${returnNumber}`;
        heading = 'Your request is under review';
        detail = `We received your ${this.returnType(event)} request ${returnNumber} for order ${orderNumber}. We will email you when its status changes.`;
        break;
      case 'RETURN_REQUEST_APPROVED':
        subject = `${returnNumber} was approved`;
        heading = 'Your request was approved';
        detail = `Your ${this.returnType(event)} request for order ${orderNumber} is approved.${this.exchangeDeadlineSuffix(event)}${messageSuffix}`;
        break;
      case 'RETURN_REQUEST_REJECTED':
        subject = `Update about ${returnNumber}`;
        heading = 'Your request was not approved';
        detail = `We could not approve your ${this.returnType(event)} request for order ${orderNumber}.${messageSuffix}`;
        break;
      case 'RETURN_REQUEST_CANCELLED':
        subject = `${returnNumber} was cancelled`;
        heading = 'Your request was cancelled';
        detail = `Your ${this.returnType(event)} request for order ${orderNumber} has been cancelled.`;
        break;
      case 'RETURN_REQUEST_RECEIVED':
        subject = `Items received for ${returnNumber}`;
        heading = 'We received your items';
        detail = `The items for ${returnNumber} have been inspected. We are now completing your resolution.${messageSuffix}`;
        break;
      case 'RETURN_REQUEST_COMPLETED':
        subject = `${returnNumber} is complete`;
        heading = 'Your request is complete';
        detail = `${this.completedReturnDetail(event, orderNumber)}${messageSuffix}`;
        break;
      case 'RETURN_REQUEST_EXPIRED':
        subject = `${returnNumber} has expired`;
        heading = 'Your exchange reservation expired';
        detail = `The replacement stock held for ${returnNumber} was released because the return was not received before its deadline. You can check the order page for current return eligibility.`;
        break;
      default:
        throw new Error('Unsupported return notification template');
    }
    return this.email(event.eventType, recipient, subject, name, heading, detail);
  }

  private completedReturnDetail(event: OutboxEventDocument, orderNumber: string): string {
    const resolution = event.payload.resolution;
    if (!resolution || typeof resolution !== 'object' || Array.isArray(resolution)) {
      return `Request ${this.payloadString(event, 'returnNumber')} for order ${orderNumber} is complete.`;
    }
    const values = resolution as Record<string, unknown>;
    if (values.type === ReturnResolutionType.Exchange) {
      const courier = typeof values.courierName === 'string' ? values.courierName : 'the courier';
      const tracking =
        typeof values.trackingNumber === 'string'
          ? ` Tracking number: ${values.trackingNumber}.`
          : '';
      return `Your replacement for order ${orderNumber} was handed to ${courier}.${tracking}`;
    }
    return `The refund resolution for order ${orderNumber} has been completed. Your bank may take additional time to show the credit.`;
  }

  private returnType(event: OutboxEventDocument): string {
    return event.payload.type === ReturnRequestType.Exchange ? 'exchange' : 'return';
  }

  private exchangeDeadlineSuffix(event: OutboxEventDocument): string {
    if (event.payload.type !== ReturnRequestType.Exchange) return '';
    const value = event.payload.exchangeReservationExpiresAt;
    const deadline =
      value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    if (!deadline || Number.isNaN(deadline.getTime())) return '';
    return ` Replacement stock is held until ${deadline.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    })}.`;
  }

  private payloadString(event: OutboxEventDocument, key: string): string {
    const value = event.payload[key];
    if (typeof value !== 'string' || !value) throw new Error(`Return event ${key} is invalid`);
    return value;
  }

  private payloadOptionalString(event: OutboxEventDocument, key: string): string | undefined {
    const value = event.payload[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private payloadNumber(event: OutboxEventDocument, key: string): number {
    const value = event.payload[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error(`Return event ${key} is invalid`);
    }
    return value;
  }

  private async renderCustomerAction(event: OutboxEventDocument): Promise<RenderedEmail | null> {
    if (event.aggregateType !== 'CUSTOMER_ACTION_TOKEN') return null;
    const action = await this.customerActionTokens
      .findOne({ _id: event.aggregateId, active: true, expiresAt: { $gt: new Date() } })
      .select('+tokenHash')
      .exec();
    const rawToken = this.payloadToken(event.payload);
    if (!action || !rawToken || !this.matchesActionToken(action, rawToken)) return null;
    if (!this.actionMatchesEvent(action, event.eventType)) return null;
    const customer = await this.customers
      .findOne({
        _id: action.customerId,
        ...(action.purpose === CustomerActionPurpose.EmailChange
          ? {}
          : { email: action.targetEmail }),
        status: AccountStatus.Active,
      })
      .exec();
    if (!customer?.email) return null;

    const name = customer.name?.trim() || 'there';
    if (action.purpose === CustomerActionPurpose.EmailVerification) {
      return this.actionEmail(
        event.eventType,
        customer.email,
        'Verify your iFixer email',
        name,
        'Verify your email',
        'Confirm this email address for your iFixer account. This secure link can be used once and expires automatically.',
        this.customerActionUrl('/verify-email', rawToken),
        'Verify email',
      );
    }
    if (action.purpose === CustomerActionPurpose.EmailChange) {
      return this.actionEmail(
        event.eventType,
        action.targetEmail,
        'Confirm your new iFixer email',
        name,
        'Confirm your new email',
        'Confirm this new email address. After confirmation, all current sessions will be signed out for your security.',
        this.customerActionUrl('/change-email', rawToken),
        'Confirm new email',
      );
    }
    return this.actionEmail(
      event.eventType,
      customer.email,
      'Reset your iFixer password',
      name,
      'Reset your password',
      'Use this one-time link to choose a new password. It expires automatically.',
      this.customerActionUrl('/reset-password', rawToken),
      'Reset password',
    );
  }

  private async resolveOrder(
    event: OutboxEventDocument,
    refund: RefundDocument | null,
  ): Promise<OrderDocument | null> {
    return this.orders.findById(refund?.orderId ?? event.aggregateId).exec();
  }

  private renderCustomer(
    eventType: string,
    recipient: string,
    order: OrderDocument,
    refund: RefundDocument | null,
  ): RenderedEmail {
    const name = order.customer.name?.trim() || order.shippingAddress.fullName;
    let subject: string;
    let heading: string;
    let detail: string;

    switch (eventType) {
      case 'ORDER_PAYMENT_CAPTURED':
        subject = `Payment received for ${order.orderNumber}`;
        heading = 'Your order is confirmed';
        detail = `We received ${this.money(order.totals.grandTotalInPaise)} for order ${order.orderNumber}.`;
        break;
      case 'ORDER_FULFILLMENT_SHIPPED': {
        subject = `${order.orderNumber} has shipped`;
        heading = 'Your order is on the way';
        const courier = order.shipping?.courierName || 'the courier';
        const tracking = order.shipping?.trackingNumber
          ? ` Tracking number: ${order.shipping.trackingNumber}.`
          : '';
        detail = `${order.orderNumber} has been handed to ${courier}.${tracking}`;
        break;
      }
      case 'ORDER_FULFILLMENT_DELIVERED':
        subject = `${order.orderNumber} was delivered`;
        heading = 'Order delivered';
        detail = `Order ${order.orderNumber} has been marked as delivered.`;
        break;
      case 'ORDER_REFUND_SUCCEEDED':
        if (!refund) throw new Error('Notification source refund was not found');
        subject = `Refund processed for ${order.orderNumber}`;
        heading = 'Your refund was processed';
        detail = `${this.money(refund.amountInPaise)} was refunded for order ${order.orderNumber}. Your bank may take additional time to show the credit.`;
        break;
      default:
        throw new Error('Unsupported customer notification template');
    }

    return this.email(eventType, recipient, subject, name, heading, detail);
  }

  private renderOperations(
    eventType: string,
    recipient: string,
    order: OrderDocument,
    refund: RefundDocument | null,
  ): RenderedEmail {
    if (eventType === 'ORDER_LATE_PAYMENT_CAPTURED') {
      return this.email(
        eventType,
        recipient,
        `Action required: late payment for ${order.orderNumber}`,
        'Operations team',
        'Late payment captured',
        `${this.money(order.totals.grandTotalInPaise)} was captured after order ${order.orderNumber} had closed. Review and refund it without reviving fulfillment.`,
      );
    }
    if (!refund) throw new Error('Notification source refund was not found');
    return this.email(
      eventType,
      recipient,
      `Action required: refund failed for ${order.orderNumber}`,
      'Operations team',
      'Refund failed',
      `Refund ${refund.refundNumber} for ${this.money(refund.amountInPaise)} failed. Review the order and Razorpay dashboard before retrying.`,
    );
  }

  private email(
    templateKey: string,
    recipient: string,
    subject: string,
    name: string,
    heading: string,
    detail: string,
  ): RenderedEmail {
    const text = `Hello ${name},\n\n${heading}\n\n${detail}\n\niFixer`;
    const html = `<!doctype html><html><body><p>Hello ${this.escape(name)},</p><h1>${this.escape(heading)}</h1><p>${this.escape(detail)}</p><p>iFixer</p></body></html>`;
    return { templateKey, recipient: recipient.trim().toLowerCase(), subject, text, html };
  }

  private actionEmail(
    templateKey: string,
    recipient: string,
    subject: string,
    name: string,
    heading: string,
    detail: string,
    actionUrl: string,
    actionLabel: string,
  ): RenderedEmail {
    const text = `Hello ${name},\n\n${heading}\n\n${detail}\n\n${actionUrl}\n\nIf you did not request this, you can ignore this email.\n\niFixer`;
    const html = `<!doctype html><html><body><p>Hello ${this.escape(name)},</p><h1>${this.escape(heading)}</h1><p>${this.escape(detail)}</p><p><a href="${this.escape(actionUrl)}">${this.escape(actionLabel)}</a></p><p>If you did not request this, you can ignore this email.</p><p>iFixer</p></body></html>`;
    return { templateKey, recipient: recipient.trim().toLowerCase(), subject, text, html };
  }

  private payloadToken(payload: Record<string, unknown>): string | undefined {
    return decryptCustomerActionToken(
      payload.tokenEnvelope,
      this.config.getOrThrow<string>('CUSTOMER_TOKEN_PEPPER'),
    );
  }

  private matchesActionToken(action: CustomerActionTokenDocument, rawToken: string): boolean {
    const expected = createHmac('sha256', this.config.getOrThrow<string>('CUSTOMER_TOKEN_PEPPER'))
      .update(rawToken)
      .digest('hex');
    if (expected.length !== action.tokenHash.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(action.tokenHash));
  }

  private actionMatchesEvent(action: CustomerActionTokenDocument, eventType: string): boolean {
    return (
      (action.purpose === CustomerActionPurpose.EmailVerification &&
        eventType === 'CUSTOMER_EMAIL_VERIFICATION_REQUESTED') ||
      (action.purpose === CustomerActionPurpose.EmailChange &&
        eventType === 'CUSTOMER_EMAIL_CHANGE_REQUESTED') ||
      (action.purpose === CustomerActionPurpose.PasswordReset &&
        eventType === 'CUSTOMER_PASSWORD_RESET_REQUESTED')
    );
  }

  private customerActionUrl(path: string, token: string): string {
    const url = new URL(path, this.config.getOrThrow<string>('PUBLIC_STOREFRONT_URL'));
    url.searchParams.set('token', token);
    return url.toString();
  }

  private operationsRecipients(): string[] {
    return [
      ...new Set(
        this.config
          .getOrThrow<string>('OPERATIONS_ALERT_EMAILS')
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }

  private money(paise: number): string {
    return `INR ${(paise / 100).toFixed(2)}`;
  }

  private escape(value: string): string {
    return value.replace(/[&<>'"]/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      };
      return entities[character];
    });
  }
}
