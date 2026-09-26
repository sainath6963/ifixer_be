import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsEnum,
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
} from 'class-validator';
import { RepairBookingStatus } from '../../database/schemas/repair.schema';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const supplied = (_object: unknown, value: unknown): boolean => value !== undefined;
export class CreateRepairBookingDto {
  @IsUUID('4') idempotencyKey!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) manageToken!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) customerName!: string;
  @Transform(trim) @IsString() @Matches(/^\+?[1-9]\d{7,14}$/) phone!: string;
  @ValidateIf(supplied) @Transform(trim) @IsEmail() @MaxLength(254) email?: string;
  @ValidateIf(supplied) @IsMongoId() brandId?: string;
  @ValidateIf(supplied) @IsMongoId() modelId?: string;
  @ValidateIf(supplied) @IsMongoId() serviceId?: string;
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(240)
  deviceDescription?: string;
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(2000) issue!: string;
  @ValidateIf(supplied)
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  requestedVisitAt?: string;
}
export class BookingChangeDto {
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedVersion!: number;
  @IsIn(['CONFIRM', 'RESCHEDULE', 'CANCEL']) action!: 'CONFIRM' | 'RESCHEDULE' | 'CANCEL';
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ValidateIf(supplied)
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  visitAt?: string;
}
export class BookingListDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page: number = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @ValidateIf(supplied) @IsEnum(RepairBookingStatus) status?: RepairBookingStatus;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(100) search?: string;
}
