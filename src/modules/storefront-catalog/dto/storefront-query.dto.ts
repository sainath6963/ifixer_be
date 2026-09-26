import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum StorefrontProductSort {
  Relevance = 'relevance',
  Newest = 'newest',
  PriceAscending = 'price-asc',
  PriceDescending = 'price-desc',
}

export class StorefrontProductQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 48, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(48)
  limit: number = 24;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ example: 'mens-shirts', maxLength: 160 })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(160)
  category?: string;

  @ApiPropertyOptional({ minimum: 0, description: 'Minimum variant price in paise' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  minPriceInPaise?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Maximum variant price in paise' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  maxPriceInPaise?: number;

  @ApiPropertyOptional({ enum: StorefrontProductSort })
  @IsOptional()
  @IsEnum(StorefrontProductSort)
  sort?: StorefrontProductSort;
}

export class StorefrontProductSlugDto {
  @ApiProperty({ example: 'classic-linen-shirt', maxLength: 220 })
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(220)
  slug!: string;
}
