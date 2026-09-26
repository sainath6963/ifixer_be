import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UpdateCustomerProfileDto {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class UpdateCustomerPreferencesDto {
  @ApiProperty()
  @IsBoolean()
  marketingEmail!: boolean;

  @ApiProperty()
  @IsBoolean()
  backInStockEmail!: boolean;

  @ApiProperty()
  @IsBoolean()
  orderUpdatesSms!: boolean;

  @ApiProperty()
  @IsBoolean()
  orderUpdatesWhatsapp!: boolean;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class RequestCustomerEmailChangeDto {
  @ApiProperty({ format: 'email', maxLength: 254 })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;

  @ApiProperty({ maxLength: 128, writeOnly: true })
  @IsString()
  @MaxLength(128)
  currentPassword!: string;
}

export class RequestCustomerMobileChangeDto {
  @ApiProperty({ example: '+919876543210' })
  @Transform(trim)
  @Matches(/^\+?[1-9]\d{7,14}$/)
  mobile!: string;

  @ApiProperty({ maxLength: 128, writeOnly: true })
  @IsString()
  @MaxLength(128)
  currentPassword!: string;
}

export class ConfirmCustomerMobileChangeDto {
  @ApiProperty()
  @IsMongoId()
  challengeId!: string;

  @ApiProperty({ pattern: '^\\d{6}$', writeOnly: true })
  @Matches(/^\d{6}$/)
  otp!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class DeactivateCustomerAccountDto {
  @ApiProperty({ maxLength: 128, writeOnly: true })
  @IsString()
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({ example: 'DEACTIVATE' })
  @Equals('DEACTIVATE')
  confirmation!: 'DEACTIVATE';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}
