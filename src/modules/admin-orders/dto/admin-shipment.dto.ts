import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ShipmentStatus } from '../../../domain/enums';

export class CreateShipmentDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ maxLength: 100, example: 'Blue Dart' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  courierName!: string;

  @ApiProperty({ maxLength: 160, example: 'BD123456789IN' })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9./_-]{2,159}$/)
  trackingNumber!: string;

  @ApiPropertyOptional({ description: 'HTTPS customer-safe tracking URL', maxLength: 500 })
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/[^\s]+$/i)
  @MaxLength(500)
  trackingUrl?: string;

  @ApiPropertyOptional({ maxLength: 100, example: 'Surface' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  serviceLevel?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 estimated delivery time' })
  @IsOptional()
  @IsDateString({ strict: true })
  estimatedDeliveryAt?: string;
}

export class UpdateShipmentStatusDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ enum: ShipmentStatus })
  @IsEnum(ShipmentStatus)
  status!: ShipmentStatus;

  @ApiProperty({ minLength: 3, maxLength: 240 })
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  message!: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  location?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 event time; defaults to server time' })
  @IsOptional()
  @IsDateString({ strict: true })
  occurredAt?: string;
}
