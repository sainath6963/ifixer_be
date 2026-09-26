import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { getAuthRequestContext } from '../admin-auth/http-context';
import { CustomerOrderNumberParamDto } from '../checkout/dto/checkout.dto';
import { CustomerAccessGuard } from '../customer/customer-access.guard';
import { CUSTOMER_ACCESS_SECURITY } from '../customer/customer.constants';
import { CustomerCsrfGuard } from '../customer/customer-csrf.guard';
import { CurrentCustomer } from '../customer/current-customer.decorator';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import { VerifyRazorpayPaymentDto } from './dto/payment.dto';
import { PaymentService } from './payment.service';
import type { PaymentVerificationResult, RazorpayCheckoutView } from './payment.types';
import { RazorpayWebhookService } from './razorpay-webhook.service';

@ApiTags('customer-payments')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/orders')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerPaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post(':orderNumber/payments/razorpay')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A unique 16-160 character key reused for the same payment initiation retry',
  })
  @ApiOperation({ summary: 'Create or recover the single Razorpay order for an internal order' })
  async initiate(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerOrderNumberParamDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<{ checkout: RazorpayCheckoutView }> {
    return {
      checkout: await this.payments.initiate(
        customer,
        params.orderNumber,
        idempotencyKey,
        getAuthRequestContext(request),
      ),
    };
  }

  @Post(':orderNumber/payments/razorpay/verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify Razorpay Checkout signature and fetch provider payment state' })
  verify(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerOrderNumberParamDto,
    @Body() input: VerifyRazorpayPaymentDto,
    @Req() request: Request,
  ): Promise<PaymentVerificationResult> {
    return this.payments.verifyBrowserPayment(
      customer,
      params.orderNumber,
      input,
      getAuthRequestContext(request),
    );
  }
}

@ApiTags('payment-webhooks')
@Controller('payments/razorpay')
export class RazorpayWebhookController {
  constructor(private readonly webhooks: RazorpayWebhookService) {}

  @Post('webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Razorpay-Signature', required: true })
  @ApiHeader({ name: 'X-Razorpay-Event-Id', required: true })
  @ApiOperation({ summary: 'Receive a signed, idempotent Razorpay webhook using the raw body' })
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ): Promise<void> {
    await this.webhooks.handle(request.rawBody, signature, eventId);
  }
}
