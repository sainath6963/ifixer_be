import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  RefundStatus,
} from '../../../domain/enums';

export class AdminOrderListQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ enum: OrderLifecycleStatus })
  @IsOptional()
  @IsEnum(OrderLifecycleStatus)
  lifecycleStatus?: OrderLifecycleStatus;

  @ApiPropertyOptional({ enum: FinancialStatus })
  @IsOptional()
  @IsEnum(FinancialStatus)
  financialStatus?: FinancialStatus;

  @ApiPropertyOptional({ enum: FulfillmentStatus })
  @IsOptional()
  @IsEnum(FulfillmentStatus)
  fulfillmentStatus?: FulfillmentStatus;

  @ApiPropertyOptional({ description: 'ISO-8601 inclusive lower creation time' })
  @IsOptional()
  @IsDateString({ strict: true })
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 inclusive upper creation time' })
  @IsOptional()
  @IsDateString({ strict: true })
  createdTo?: string;
}

export class UpdateFulfillmentDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ enum: FulfillmentStatus })
  @IsEnum(FulfillmentStatus)
  status!: FulfillmentStatus;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  courierName?: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9./_-]{2,159}$/)
  trackingNumber?: string;

  @ApiPropertyOptional({ description: 'HTTPS customer-safe tracking URL', maxLength: 500 })
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/[^\s]+$/i)
  @MaxLength(500)
  trackingUrl?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class UpdateAdminNoteDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ maxLength: 2000, description: 'Empty string clears the private admin note' })
  @IsString()
  @MaxLength(2000)
  adminNote!: string;
}

export class CreateRefundDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedOrderVersion!: number;

  @ApiProperty({ minimum: 1, description: 'Exact integer paise to refund' })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountInPaise!: number;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ example: true, description: 'Explicit confirmation for an irreversible action' })
  @IsBoolean()
  @Equals(true)
  confirmRefund!: true;
}

export class AdminRefundListQueryDto {
  @ApiPropertyOptional({ enum: RefundStatus })
  @IsOptional()
  @IsEnum(RefundStatus)
  status?: RefundStatus;
}
