import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class SavedAddressFieldsDto {
  @ApiProperty({ maxLength: 50, example: 'Home' })
  @IsString()
  @Matches(/\S/)
  @MaxLength(50)
  label!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ example: '+919999999999' })
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/)
  phone!: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  line1!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  line2?: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  city!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @Matches(/\S/)
  @MaxLength(100)
  state!: string;

  @ApiProperty({ example: '411001' })
  @IsString()
  @Matches(/^\d{6}$/)
  postalCode!: string;

  @ApiPropertyOptional({ enum: ['IN'], default: 'IN' })
  @IsOptional()
  @IsString()
  @Equals('IN')
  countryCode = 'IN' as const;
}

export class CreateSavedAddressDto extends SavedAddressFieldsDto {
  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault = false;
}

export class ReplaceSavedAddressDto extends SavedAddressFieldsDto {
  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class AddressBookMutationDto {
  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class CustomerAddressIdParamDto {
  @ApiProperty()
  @IsMongoId()
  addressId!: string;
}
