import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';

import { CART_MAX_ITEM_QUANTITY } from '../customer.constants';

export class CartVariantParamDto {
  @ApiProperty({ description: 'Public product variant ID' })
  @IsMongoId()
  variantId!: string;
}

export class SetCartItemDto {
  @ApiProperty({ description: 'Public product ID' })
  @IsMongoId()
  productId!: string;

  @ApiProperty({ minimum: 1, maximum: CART_MAX_ITEM_QUANTITY })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CART_MAX_ITEM_QUANTITY)
  quantity!: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Last cart version observed by the client' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class CartMutationVersionDto {
  @ApiPropertyOptional({ minimum: 0, description: 'Last cart version observed by the client' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
