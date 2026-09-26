import { BadRequestException } from '@nestjs/common';

import type { ResolvedAnalyticsPeriod } from './admin-analytics.types';
import { AnalyticsGranularity, type AdminAnalyticsQueryDto } from './dto/admin-analytics.dto';

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86_400_000;

export function resolveAnalyticsPeriod(
  query: AdminAnalyticsQueryDto,
  now = new Date(),
): ResolvedAnalyticsPeriod {
  if (Boolean(query.dateFrom) !== Boolean(query.dateTo)) {
    throw rangeError('Provide both dateFrom and dateTo');
  }
  const today = istDateString(now);
  const toExclusive = query.dateTo ? nextIstDay(query.dateTo) : nextIstDay(today);
  const from = query.dateFrom
    ? parseIstDate(query.dateFrom)
    : new Date(toExclusive.getTime() - 30 * DAY_MS);
  if (from >= toExclusive) throw rangeError('dateFrom must be on or before dateTo');
  const days = Math.round((toExclusive.getTime() - from.getTime()) / DAY_MS);
  if (days > 366) throw rangeError('Analytics date range cannot exceed 366 days');
  const granularity = resolveGranularity(query.granularity, days);
  const previousToExclusive = from;
  const previousFrom = new Date(from.getTime() - days * DAY_MS);
  return {
    dateFrom: istDateString(from),
    dateTo: istDateString(new Date(toExclusive.getTime() - DAY_MS)),
    timezone: 'Asia/Kolkata',
    days,
    granularity,
    from,
    toExclusive,
    previousFrom,
    previousToExclusive,
  };
}

export function analyticsBucketKeys(period: ResolvedAnalyticsPeriod): string[] {
  const keys = new Set<string>();
  for (
    let cursor = period.from.getTime();
    cursor < period.toExclusive.getTime();
    cursor += DAY_MS
  ) {
    const date = istDateString(new Date(cursor));
    keys.add(bucketKey(date, period.granularity));
  }
  return [...keys];
}

export function analyticsBucketFormat(granularity: ResolvedAnalyticsPeriod['granularity']): string {
  if (granularity === AnalyticsGranularity.Day) return '%Y-%m-%d';
  if (granularity === AnalyticsGranularity.Month) return '%Y-%m';
  return '%G-W%V';
}

export function metric(
  value: number,
  previousValue: number,
): {
  value: number;
  previousValue: number;
  changePercent: number | null;
} {
  return {
    value,
    previousValue,
    changePercent:
      previousValue === 0
        ? value === 0
          ? 0
          : null
        : Number((((value - previousValue) / previousValue) * 100).toFixed(1)),
  };
}

function resolveGranularity(
  input: AnalyticsGranularity,
  days: number,
): ResolvedAnalyticsPeriod['granularity'] {
  const automatic =
    days <= 45
      ? AnalyticsGranularity.Day
      : days <= 180
        ? AnalyticsGranularity.Week
        : AnalyticsGranularity.Month;
  const result = input === AnalyticsGranularity.Auto ? automatic : input;
  if (result === AnalyticsGranularity.Day && days > 90) {
    throw rangeError('Daily granularity supports at most 90 days');
  }
  return result;
}

function parseIstDate(input: string): Date {
  const [year, month, day] = input.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
  if (istDateString(parsed) !== input)
    throw rangeError('Analytics dates must be valid calendar dates');
  return parsed;
}

function nextIstDay(input: string): Date {
  return new Date(parseIstDate(input).getTime() + DAY_MS);
}

function istDateString(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function bucketKey(date: string, granularity: ResolvedAnalyticsPeriod['granularity']): string {
  if (granularity === AnalyticsGranularity.Day) return date;
  if (granularity === AnalyticsGranularity.Month) return date.slice(0, 7);
  const parsed = new Date(`${date}T00:00:00Z`);
  const weekday = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((parsed.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${parsed.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function rangeError(message: string): BadRequestException {
  return new BadRequestException({ code: 'ANALYTICS_DATE_RANGE_INVALID', message });
}
