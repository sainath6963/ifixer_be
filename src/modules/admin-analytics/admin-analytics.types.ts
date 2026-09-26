import type { AnalyticsGranularity } from './dto/admin-analytics.dto';

export interface AnalyticsPeriod {
  dateFrom: string;
  dateTo: string;
  timezone: 'Asia/Kolkata';
  days: number;
  granularity: Exclude<AnalyticsGranularity, AnalyticsGranularity.Auto>;
}

export interface ResolvedAnalyticsPeriod extends AnalyticsPeriod {
  from: Date;
  toExclusive: Date;
  previousFrom: Date;
  previousToExclusive: Date;
}

export interface AnalyticsMetric {
  value: number;
  previousValue: number;
  changePercent: number | null;
}

export interface AnalyticsTrendPoint {
  key: string;
  grossSalesInPaise: number;
  refundsInPaise: number;
  netRevenueInPaise: number;
  orders: number;
  newCustomers: number;
}

export interface AdminAnalyticsOverview {
  period: AnalyticsPeriod;
  kpis: {
    grossSalesInPaise: AnalyticsMetric;
    refundsInPaise: AnalyticsMetric;
    netRevenueInPaise: AnalyticsMetric;
    paidOrders: AnalyticsMetric;
    averageOrderValueInPaise: AnalyticsMetric;
    newCustomers: AnalyticsMetric;
  };
  trend: AnalyticsTrendPoint[];
  topProducts: Array<{
    productId: string;
    name: string;
    slug: string;
    unitsSold: number;
    itemSalesInPaise: number;
  }>;
  lowStock: Array<{
    productId: string;
    productName: string;
    variantId: string;
    variantTitle: string;
    sku: string;
    available: number;
    reorderPoint: number;
  }>;
  generatedAt: string;
}
