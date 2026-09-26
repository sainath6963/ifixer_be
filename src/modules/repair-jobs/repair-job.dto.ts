import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { RepairJobStatus, repairTestKeys } from '../../database/schemas/repair-job.schema';
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const supplied = (_object: unknown, value: unknown): boolean => value !== undefined;
export class JobVersionDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) expectedVersion!: number;
}
export class CreateJobDto {
  @IsUUID('4') idempotencyKey!: string;
  @ValidateIf(supplied) @Matches(/^IFX-[A-F0-9]{16}$/) bookingReference?: string;
  @ValidateIf(supplied) @IsInt() @Min(0) expectedBookingVersion?: number;
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  customerName?: string;
  @ValidateIf(supplied) @Transform(trim) @Matches(/^\+?[1-9]\d{7,14}$/) phone?: string;
  @ValidateIf(supplied) @Transform(trim) @IsEmail() @MaxLength(254) email?: string;
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(400)
  deviceLabel?: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MinLength(10) @MaxLength(2000) issue?: string;
  @ValidateIf(supplied) @Matches(/^\d{15}$/) imei?: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) serial?: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) condition!: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(1000) accessories!: string;
  @ValidateIf(supplied)
  @IsDateString({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  targetAt?: string;
}
export class JobListDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @ValidateIf(supplied) @IsEnum(RepairJobStatus) status?: RepairJobStatus;
  @ValidateIf(supplied) @IsIn(['IN_SHOP', 'RETURNED']) custody?: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(100) search?: string;
}
export class JobAssignmentDto extends JobVersionDto {
  @IsMongoId() technicianId!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}
export class JobTextDto extends JobVersionDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000) text!: string;
}
export class JobTransitionDto extends JobVersionDto {
  @IsEnum(RepairJobStatus) status!: RepairJobStatus;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
  @ValidateIf(supplied)
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  recipient?: string;
}
export class JobReturnDto extends JobVersionDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) recipient!: string;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class EstimateLineDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) description!: string;
  @IsInt() @Min(1) @Max(100) quantity!: number;
  @IsInt() @Min(0) @Max(1000000000) unitPriceInPaise!: number;
}
export class JobEstimateDto extends JobVersionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => EstimateLineDto)
  lines!: EstimateLineDto[];
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class JobApprovalDto extends JobVersionDto {
  @IsInt() @Min(1) @Max(100) revision!: number;
  @IsIn(['APPROVED', 'DECLINED']) decision!: 'APPROVED' | 'DECLINED';
  @IsIn(['IN_PERSON', 'PHONE', 'MESSAGE']) method!: 'IN_PERSON' | 'PHONE' | 'MESSAGE';
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) customerName!: string;
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(1000) evidence!: string;
}
export class JobTestDto {
  @IsIn(repairTestKeys) key!: string;
  @IsIn(['PASS', 'FAIL', 'NA']) result!: string;
  @ValidateIf(supplied) @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}
export class JobTestsDto extends JobVersionDto {
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => JobTestDto)
  tests!: JobTestDto[];
}
export class CreateRepairMemberDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @Transform(trim) @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
  @IsIn(['RECEPTION', 'TECHNICIAN']) role!: 'RECEPTION' | 'TECHNICIAN';
}
export class RepairMemberStatusDto extends JobVersionDto {
  @IsIn(['ACTIVE', 'DISABLED']) status!: 'ACTIVE' | 'DISABLED';
}
