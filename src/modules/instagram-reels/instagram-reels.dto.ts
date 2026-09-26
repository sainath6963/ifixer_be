import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
export class SaveInstagramReelDto {
  @Transform(trim) @IsString() @MaxLength(2048) url!: string;
  @Transform(trim) @IsString() @MaxLength(120) title = '';
  @IsBoolean() active!: boolean;
  @IsInt() @Min(0) @Max(9999) sortOrder!: number;
  @ValidateIf((_: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
export class InstagramReelsQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
