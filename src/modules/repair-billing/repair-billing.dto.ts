import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsDefined,
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
const supplied = (_: unknown, value: unknown): boolean => value !== undefined;
export class BillingOperationDto {
  @IsUUID('4') idempotencyKey!: string;
}
export class BillingJobDto extends BillingOperationDto {
  @IsInt() @Min(0) expectedJobVersion!: number;
}
export class IssuerDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(1000) address!: string;
  @Transform(trim) @Matches(/^\+?[1-9]\d{7,14}$/) phone!: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) taxId?: string;
}
export class TaxDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) label!: string;
  @IsInt() @Min(0) @Max(10000) rateBps!: number;
}
export class BillingSettingsDto extends BillingOperationDto {
  @IsInt() @Min(-1) expectedVersion!: number;
  @IsDefined() @ValidateNested() @Type(() => IssuerDto) issuer!: IssuerDto;
  @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => TaxDto) taxes!: TaxDto[];
  @IsInt() @Min(0) @Max(1095) warrantyDays!: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) warrantyCoverage!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) warrantyExclusions!: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(1000) invoiceNote?: string;
}
export class InvoiceLineDto {
  @IsIn(['PART', 'LABOUR', 'SERVICE']) kind!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) description!: string;
  @IsInt() @Min(1) @Max(100) quantity!: number;
  @IsInt() @Min(0) @Max(1000000000) unitPriceInPaise!: number;
}
export class IssueInvoiceDto extends BillingJobDto {
  @IsInt() @Min(0) expectedSettingsVersion!: number;
  @IsInt() @Min(1) @Max(100) estimateRevision!: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
  @IsInt() @Min(0) @Max(1000000000) discountInPaise!: number;
  @IsBoolean() applyTax!: boolean;
  @IsInt() @Min(0) @Max(1000000000) expectedTotalInPaise!: number;
  @IsInt() @Min(0) @Max(1095) warrantyDays!: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) warrantyCoverage!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) warrantyExclusions!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class MoneyDto extends BillingJobDto {
  @IsInt() @Min(1) @Max(1000000000) amountInPaise!: number;
  @IsIn(['CASH', 'UPI']) method!: string;
  @ValidateIf(supplied)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9][A-Z0-9._:/-]{2,99}$/)
  reference?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class RefundDto extends MoneyDto {
  @IsMongoId() paymentId!: string;
}
export class CreditDto extends BillingJobDto {
  @IsInt() @Min(1) @Max(1000000000) amountInPaise!: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class DeliveryCreditDto extends BillingJobDto {
  @IsBoolean() allow!: boolean;
  @IsInt() @Min(0) @Max(1000000000) expectedDueInPaise!: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class WarrantyFollowupDto extends BillingJobDto {
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(2000) issue!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) condition!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(1000) accessories!: string;
}
export class InvoiceQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(100) search?: string;
}
