import type { AnalyticsMetric, AnalyticsPeriod } from '../admin-analytics/admin-analytics.types';

export interface WebsiteInsightsOverview {
  period: AnalyticsPeriod;
  kpis: {
    pageViews: AnalyticsMetric;
    visits: AnalyticsMetric;
    uniqueVisitors: AnalyticsMetric;
    googleReviewClicks: AnalyticsMetric;
  };
  trend: Array<{
    key: string;
    pageViews: number;
    visits: number;
    uniqueVisitors: number;
  }>;
  topPages: Array<{ path: string; pageViews: number; visits: number }>;
  sources: Array<{ source: string; visits: number }>;
  devices: Array<{ device: string; pageViews: number; visits: number }>;
  generatedAt: string;
}

export interface GoogleReviewSettingView {
  googleReviewUrl: string;
  configured: boolean;
  version: number;
}
