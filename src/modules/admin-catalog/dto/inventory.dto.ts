import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min, NotEquals } from 'class-validator';

export class AdjustInventoryDto {
  @ApiProperty({ description: 'Signed change to physical on-hand stock' })
  @IsInt()
  @Min(Number.MIN_SAFE_INTEGER)
  @Max(Number.MAX_SAFE_INTEGER)
  @NotEquals(0)
  deltaOnHand!: number;

  @ApiProperty({ maxLength: 100, description: 'Stable client-generated retry key' })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/)
  idempotencyKey!: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  note!: string;
}
