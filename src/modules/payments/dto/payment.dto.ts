import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

import {
  RAZORPAY_PROVIDER_ORDER_PATTERN,
  RAZORPAY_PROVIDER_PAYMENT_PATTERN,
  RAZORPAY_SIGNATURE_PATTERN,
} from '../payment.constants';

export class VerifyRazorpayPaymentDto {
  @ApiProperty({ example: 'order_RB58MiP5SPFYyM', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  @Matches(RAZORPAY_PROVIDER_ORDER_PATTERN)
  razorpayOrderId!: string;

  @ApiProperty({ example: 'pay_RB58MiP5SPFYyM', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  @Matches(RAZORPAY_PROVIDER_PAYMENT_PATTERN)
  razorpayPaymentId!: string;

  @ApiProperty({ description: 'Razorpay Checkout HMAC signature', minLength: 64, maxLength: 64 })
  @IsString()
  @Matches(RAZORPAY_SIGNATURE_PATTERN)
  razorpaySignature!: string;
}
