import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  ReturnReason,
  ReturnRequestStatus,
  ReturnRequestType,
  ReturnResolutionType,
} from '../../../domain/enums';

export class CreateReturnItemDto {
  @ApiProperty()
  @IsMongoId()
  variantId!: string;

  @ApiProperty({ minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @ApiProperty({ enum: ReturnReason })
  @IsEnum(ReturnReason)
  reason!: ReturnReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reasonDetail?: string;

  @ApiPropertyOptional({ description: 'Required for exchange items' })
  @IsOptional()
  @IsMongoId()
  requestedExchangeVariantId?: string;
}

export class CreateReturnRequestDto {
  @ApiProperty({ enum: ReturnRequestType })
  @IsEnum(ReturnRequestType)
  type!: ReturnRequestType;

  @ApiProperty({ type: [CreateReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateReturnItemDto)
  items!: CreateReturnItemDto[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customerNote?: string;
}

export class ReturnNumberParamDto {
  @ApiProperty({ example: 'RT-20260810-ABCDEF123456' })
  @IsString()
  @Matches(/^RT-\d{8}-[A-F0-9]{12}$/)
  returnNumber!: string;
}

export class CustomerOrderReturnParamsDto extends ReturnNumberParamDto {
  @ApiProperty()
  @IsString()
  @Matches(/^RC-\d{8}-[A-F0-9]{10}$/)
  orderNumber!: string;
}

export class CancelReturnRequestDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class AdminReturnListQueryDto {
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

  @ApiPropertyOptional({ enum: ReturnRequestStatus })
  @IsOptional()
  @IsEnum(ReturnRequestStatus)
  status?: ReturnRequestStatus;

  @ApiPropertyOptional({ enum: ReturnRequestType })
  @IsOptional()
  @IsEnum(ReturnRequestType)
  type?: ReturnRequestType;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class DecideReturnRequestDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ enum: [ReturnRequestStatus.Approved, ReturnRequestStatus.Rejected] })
  @IsEnum(ReturnRequestStatus)
  status!: ReturnRequestStatus.Approved | ReturnRequestStatus.Rejected;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  customerMessage?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;
}

export class ReceiveReturnItemDto {
  @ApiProperty()
  @IsMongoId()
  variantId!: string;

  @ApiProperty({ minimum: 0, maximum: 10 })
  @IsInt()
  @Min(0)
  @Max(10)
  restockQuantity!: number;
}

export class ReceiveReturnRequestDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ type: [ReceiveReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ReceiveReturnItemDto)
  items!: ReceiveReturnItemDto[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customerMessage?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;
}

export class CompleteReturnRequestDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ enum: ReturnResolutionType })
  @IsEnum(ReturnResolutionType)
  resolutionType!: ReturnResolutionType;

  @ApiPropertyOptional({ description: 'Succeeded Razorpay refund ID for return resolution' })
  @IsOptional()
  @IsMongoId()
  refundId?: string;

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

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/[^\s]+$/i)
  @MaxLength(500)
  trackingUrl?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  customerMessage?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;
}
