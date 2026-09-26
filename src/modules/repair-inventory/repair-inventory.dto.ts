import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsMongoId,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const supplied = (_object: unknown, value: unknown): boolean => value !== undefined;
export class StockOperationDto {
  @IsUUID('4') idempotencyKey!: string;
}
export class InventoryQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(100) search?: string;
  @ValidateIf(supplied) @IsMongoId() modelId?: string;
  @ValidateIf(supplied) @IsIn(['true', 'false']) lowStock?: string;
  @ValidateIf(supplied) @IsIn(['true', 'false']) active?: string;
  @ValidateIf(supplied) @IsMongoId() partId?: string;
  @ValidateIf(supplied) @Matches(/^JOB-[A-F0-9]{16}$/) jobNumber?: string;
}
export class SupplierDto extends StockOperationDto {
  @ValidateIf(supplied) @IsInt() @Min(0) expectedVersion?: number;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,39}$/)
  code!: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(120) contactName?: string;
  @ValidateIf(supplied) @Transform(trim) @Matches(/^\+?[1-9]\d{7,14}$/) phone?: string;
  @ValidateIf(supplied) @Transform(trim) @IsEmail() @MaxLength(254) email?: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(1000) address?: string;
  @IsBoolean() active!: boolean;
}
export class SparePartDto extends StockOperationDto {
  @ValidateIf(supplied) @IsInt() @Min(0) expectedVersion?: number;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9._-]{1,99}$/)
  sku!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) quality!: string;
  @IsArray() @ArrayMaxSize(50) @ArrayUnique() @IsMongoId({ each: true }) modelIds!: string[];
  @ValidateIf(supplied) @IsMongoId() supplierId?: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(120) bin?: string;
  @ValidateIf(supplied) @IsInt() @Min(0) @Max(1000000000) referenceCostInPaise?: number;
  @IsInt() @Min(0) @Max(1000000000) customerPriceInPaise!: number;
  @IsInt() @Min(0) @Max(1000000) reorderPoint!: number;
  @IsBoolean() active!: boolean;
}
export class StockAdjustmentDto extends StockOperationDto {
  @IsInt() @Min(0) expectedVersion!: number;
  @IsIn(['OPENING', 'ADJUST_IN', 'ADJUST_OUT', 'DAMAGE', 'SUPPLIER_RETURN']) action!:
    'OPENING' | 'ADJUST_IN' | 'ADJUST_OUT' | 'DAMAGE' | 'SUPPLIER_RETURN';
  @IsInt() @Min(1) @Max(100000) quantity!: number;
  @ValidateIf(supplied) @IsInt() @Min(0) @Max(1000000000) unitCostInPaise?: number;
  @ValidateIf(supplied) @IsMongoId() lotId?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class PurchaseLineDto {
  @IsMongoId() partId!: string;
  @IsInt() @Min(1) @Max(100000) quantity!: number;
  @IsInt() @Min(0) @Max(1000000000) unitCostInPaise!: number;
}
export class PurchaseDto extends StockOperationDto {
  @IsMongoId() supplierId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines!: PurchaseLineDto[];
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}
export class ReceiptLineDto {
  @IsInt() @Min(0) @Max(29) lineIndex!: number;
  @IsInt() @Min(1) @Max(100000) quantity!: number;
  @IsInt() @Min(0) @Max(1000000000) unitCostInPaise!: number;
}
export class ReceiptDto extends StockOperationDto {
  @IsInt() @Min(0) expectedVersion!: number;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) reference!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) note!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  lines!: ReceiptLineDto[];
}
export class PurchaseCancelDto extends StockOperationDto {
  @IsInt() @Min(0) expectedVersion!: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class ReservePartDto extends StockOperationDto {
  @IsInt() @Min(0) expectedJobVersion!: number;
  @IsMongoId() partId!: string;
  @IsInt() @Min(1) @Max(100) quantity!: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) compatibilityNote!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class JobPartActionDto extends StockOperationDto {
  @IsInt() @Min(0) expectedJobVersion!: number;
  @IsIn(['CONSUME', 'RELEASE', 'RETURN_USABLE', 'RETURN_DAMAGED']) action!:
    'CONSUME' | 'RELEASE' | 'RETURN_USABLE' | 'RETURN_DAMAGED';
  @ValidateIf(supplied) @IsInt() @Min(1) @Max(100) quantity?: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
