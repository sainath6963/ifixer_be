import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class ShippingAddressDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ example: '+919999999999' })
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/)
  phone!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  city!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  state!: string;

  @ApiProperty({ example: '411001' })
  @IsString()
  @Matches(/^\d{6}$/)
  postalCode!: string;

  @ApiProperty({ enum: ['IN'], default: 'IN' })
  @IsString()
  @Equals('IN')
  countryCode = 'IN' as const;
}

export class CheckoutRequestDto {
  @ApiProperty({ minimum: 0, description: 'Last cart version observed by the customer' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedCartVersion!: number;

  @ApiPropertyOptional({ example: 'WELCOME10', minLength: 3, maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/)
  @MaxLength(32)
  couponCode?: string;

  @ApiProperty({ type: ShippingAddressDto })
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress!: ShippingAddressDto;
}

export class CustomerOrderListQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}

export class CustomerOrderNumberParamDto {
  @ApiProperty({ example: 'RC-20260808-A1B2C3D4E5', maxLength: 40 })
  @IsString()
  @Matches(/^RC-[0-9]{8}-[A-F0-9]{10}$/)
  @MaxLength(40)
  orderNumber!: string;
}
