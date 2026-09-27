import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class WebsiteEventDto {
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,100}$/)
  visitorId!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,100}$/)
  sessionId!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(200)
  @Matches(/^\/(?!\/)[^\s?#]*$/)
  path!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  referrer = '';

  @Type(() => Number)
  @IsInt()
  @Min(200)
  @Max(10_000)
  viewportWidth!: number;
}

export class SaveGoogleReviewSettingDto {
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  googleReviewUrl!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
