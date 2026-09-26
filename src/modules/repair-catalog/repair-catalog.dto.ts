import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { RepairPricingMode } from '../../database/schemas/repair.schema';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CatalogBaseDto {
  @IsBoolean() active!: boolean;
  @IsInt() @Min(0) @Max(100000) sortOrder: number = 0;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion?: number;
}
export class BrandDto extends CatalogBaseDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MaxLength(160) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug!: string;
}
export class ModelDto extends BrandDto {
  @IsMongoId() brandId!: string;
}
export class ServiceDto extends BrandDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1200) description!: string;
  @IsEnum(RepairPricingMode) pricingMode!: RepairPricingMode;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1000000000)
  priceInPaise?: number;
}
export class OptionDto extends CatalogBaseDto {
  @IsMongoId() modelId!: string;
  @IsMongoId() serviceId!: string;
  @IsEnum(RepairPricingMode) pricingMode!: RepairPricingMode;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1000000000)
  priceInPaise?: number;
}
