import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches } from 'class-validator';

export enum AnalyticsGranularity {
  Auto = 'AUTO',
  Day = 'DAY',
  Week = 'WEEK',
  Month = 'MONTH',
}

export class AdminAnalyticsQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01', description: 'Asia/Kolkata calendar date' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'Inclusive Asia/Kolkata date' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;

  @ApiPropertyOptional({ enum: AnalyticsGranularity, default: AnalyticsGranularity.Auto })
  @IsOptional()
  @IsEnum(AnalyticsGranularity)
  granularity: AnalyticsGranularity = AnalyticsGranularity.Auto;
}
