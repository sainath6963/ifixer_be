import { analyticsBucketKeys, metric, resolveAnalyticsPeriod } from './admin-analytics-period';
import { AnalyticsGranularity } from './dto/admin-analytics.dto';

describe('admin analytics period', () => {
  it('defaults to 30 India business days and an equal comparison window', () => {
    const period = resolveAnalyticsPeriod(
      { granularity: AnalyticsGranularity.Auto },
      new Date('2026-08-20T20:00:00.000Z'),
    );

    expect(period).toMatchObject({
      dateFrom: '2026-07-23',
      dateTo: '2026-08-21',
      days: 30,
      timezone: 'Asia/Kolkata',
      granularity: AnalyticsGranularity.Day,
    });
    expect(period.toExclusive.toISOString()).toBe('2026-08-21T18:30:00.000Z');
    expect(period.previousFrom.toISOString()).toBe('2026-06-22T18:30:00.000Z');
  });

  it('uses automatic weekly/monthly grouping and fills every period key', () => {
    const weekly = resolveAnalyticsPeriod({
      dateFrom: '2026-01-01',
      dateTo: '2026-03-01',
      granularity: AnalyticsGranularity.Auto,
    });
    expect(weekly.granularity).toBe(AnalyticsGranularity.Week);
    expect(analyticsBucketKeys(weekly)).toEqual([
      '2026-W01',
      '2026-W02',
      '2026-W03',
      '2026-W04',
      '2026-W05',
      '2026-W06',
      '2026-W07',
      '2026-W08',
      '2026-W09',
    ]);

    const monthly = resolveAnalyticsPeriod({
      dateFrom: '2025-08-01',
      dateTo: '2026-08-01',
      granularity: AnalyticsGranularity.Auto,
    });
    expect(monthly.granularity).toBe(AnalyticsGranularity.Month);
    expect(analyticsBucketKeys(monthly)).toHaveLength(13);
  });

  it('rejects incomplete, impossible, oversized, and excessively granular ranges', () => {
    expect(() =>
      resolveAnalyticsPeriod({
        dateFrom: '2026-01-01',
        granularity: AnalyticsGranularity.Auto,
      }),
    ).toThrow('Provide both');
    expect(() =>
      resolveAnalyticsPeriod({
        dateFrom: '2026-02-30',
        dateTo: '2026-03-01',
        granularity: AnalyticsGranularity.Auto,
      }),
    ).toThrow('valid calendar dates');
    expect(() =>
      resolveAnalyticsPeriod({
        dateFrom: '2025-01-01',
        dateTo: '2026-02-01',
        granularity: AnalyticsGranularity.Auto,
      }),
    ).toThrow('cannot exceed 366');
    expect(() =>
      resolveAnalyticsPeriod({
        dateFrom: '2026-01-01',
        dateTo: '2026-04-30',
        granularity: AnalyticsGranularity.Day,
      }),
    ).toThrow('at most 90 days');
  });

  it('does not fabricate percentage growth from a zero comparison base', () => {
    expect(metric(100, 0)).toEqual({ value: 100, previousValue: 0, changePercent: null });
    expect(metric(0, 0)).toEqual({ value: 0, previousValue: 0, changePercent: 0 });
    expect(metric(75, 100)).toEqual({ value: 75, previousValue: 100, changePercent: -25 });
  });
});
