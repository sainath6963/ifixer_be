import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Customer } from '../../database/schemas/identity.schema';
import { InventoryLevel } from '../../database/schemas/inventory.schema';
import { PaymentAttempt, Refund } from '../../database/schemas/payment.schema';
import { PaymentAttemptStatus, ProductStatus, RefundStatus } from '../../domain/enums';
import {
  analyticsBucketFormat,
  analyticsBucketKeys,
  metric,
  resolveAnalyticsPeriod,
} from './admin-analytics-period';
import type {
  AdminAnalyticsOverview,
  AnalyticsTrendPoint,
  ResolvedAnalyticsPeriod,
} from './admin-analytics.types';
import type { AdminAnalyticsQueryDto } from './dto/admin-analytics.dto';

interface PaymentSummaryRow {
  _id: null;
  grossSalesInPaise: number;
  orders: number;
}

interface ValueSummaryRow {
  _id: null;
  value: number;
}

interface TrendRow {
  _id: string;
  value: number;
  count?: number;
}

interface TopProductRow {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  unitsSold: number;
  itemSalesInPaise: number;
}

interface LowStockRow {
  _id: Types.ObjectId;
  productId: Types.ObjectId;
  productName: string;
  variantId: Types.ObjectId;
  variantTitle: string;
  sku: string;
  available: number;
  reorderPoint: number;
}

@Injectable()
export class AdminAnalyticsService {
  constructor(
    @InjectModel(PaymentAttempt.name) private readonly payments: Model<PaymentAttempt>,
    @InjectModel(Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
  ) {}

  async overview(query: AdminAnalyticsQueryDto): Promise<AdminAnalyticsOverview> {
    const period = resolveAnalyticsPeriod(query);
    const [
      currentPayments,
      previousPayments,
      currentRefunds,
      previousRefunds,
      currentCustomers,
      previousCustomers,
      paymentTrend,
      refundTrend,
      customerTrend,
      topProducts,
      lowStock,
    ] = await Promise.all([
      this.paymentSummary(period.from, period.toExclusive),
      this.paymentSummary(period.previousFrom, period.previousToExclusive),
      this.refundSummary(period.from, period.toExclusive),
      this.refundSummary(period.previousFrom, period.previousToExclusive),
      this.customerSummary(period.from, period.toExclusive),
      this.customerSummary(period.previousFrom, period.previousToExclusive),
      this.paymentTrend(period),
      this.refundTrend(period),
      this.customerTrend(period),
      this.topProducts(period),
      this.lowStock(),
    ]);
    const currentNet = currentPayments.grossSalesInPaise - currentRefunds;
    const previousNet = previousPayments.grossSalesInPaise - previousRefunds;
    const currentAverage = currentPayments.orders
      ? Math.round(currentPayments.grossSalesInPaise / currentPayments.orders)
      : 0;
    const previousAverage = previousPayments.orders
      ? Math.round(previousPayments.grossSalesInPaise / previousPayments.orders)
      : 0;

    return {
      period: {
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        timezone: period.timezone,
        days: period.days,
        granularity: period.granularity,
      },
      kpis: {
        grossSalesInPaise: metric(
          currentPayments.grossSalesInPaise,
          previousPayments.grossSalesInPaise,
        ),
        refundsInPaise: metric(currentRefunds, previousRefunds),
        netRevenueInPaise: metric(currentNet, previousNet),
        paidOrders: metric(currentPayments.orders, previousPayments.orders),
        averageOrderValueInPaise: metric(currentAverage, previousAverage),
        newCustomers: metric(currentCustomers, previousCustomers),
      },
      trend: this.mergeTrend(period, paymentTrend, refundTrend, customerTrend),
      topProducts: topProducts.map((row) => ({
        productId: row._id.toHexString(),
        name: row.name,
        slug: row.slug,
        unitsSold: row.unitsSold,
        itemSalesInPaise: row.itemSalesInPaise,
      })),
      lowStock: lowStock.map((row) => ({
        productId: row.productId.toHexString(),
        productName: row.productName,
        variantId: row.variantId.toHexString(),
        variantTitle: row.variantTitle,
        sku: row.sku,
        available: row.available,
        reorderPoint: row.reorderPoint,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  async csv(query: AdminAnalyticsQueryDto): Promise<{ filename: string; body: string }> {
    const overview = await this.overview(query);
    const rows = [
      [
        'Period',
        'Gross sales (INR)',
        'Refunds (INR)',
        'Net revenue (INR)',
        'Paid orders',
        'New customers',
      ],
      ...overview.trend.map((point) => [
        point.key,
        this.rupees(point.grossSalesInPaise),
        this.rupees(point.refundsInPaise),
        this.rupees(point.netRevenueInPaise),
        String(point.orders),
        String(point.newCustomers),
      ]),
    ];
    return {
      filename: `rich-culture-analytics-${overview.period.dateFrom}-to-${overview.period.dateTo}.csv`,
      body: `\uFEFF${rows.map((row) => row.map((cell) => this.csvCell(cell)).join(',')).join('\r\n')}\r\n`,
    };
  }

  private async paymentSummary(from: Date, to: Date): Promise<PaymentSummaryRow> {
    const [row] = await this.payments.aggregate<PaymentSummaryRow>([
      {
        $match: {
          status: PaymentAttemptStatus.Captured,
          capturedAt: { $gte: from, $lt: to },
        },
      },
      { $group: { _id: null, grossSalesInPaise: { $sum: '$amountInPaise' }, orders: { $sum: 1 } } },
    ]);
    return row ?? { _id: null, grossSalesInPaise: 0, orders: 0 };
  }

  private async refundSummary(from: Date, to: Date): Promise<number> {
    const [row] = await this.refunds.aggregate<ValueSummaryRow>([
      { $match: { status: RefundStatus.Succeeded, processedAt: { $gte: from, $lt: to } } },
      { $group: { _id: null, value: { $sum: '$amountInPaise' } } },
    ]);
    return row?.value ?? 0;
  }

  private customerSummary(from: Date, to: Date): Promise<number> {
    return this.customers.countDocuments({ createdAt: { $gte: from, $lt: to } }).exec();
  }

  private paymentTrend(period: ResolvedAnalyticsPeriod): Promise<TrendRow[]> {
    return this.payments.aggregate<TrendRow>([
      {
        $match: {
          status: PaymentAttemptStatus.Captured,
          capturedAt: { $gte: period.from, $lt: period.toExclusive },
        },
      },
      {
        $group: {
          _id: this.dateKey('$capturedAt', period),
          value: { $sum: '$amountInPaise' },
          count: { $sum: 1 },
        },
      },
    ]);
  }

  private refundTrend(period: ResolvedAnalyticsPeriod): Promise<TrendRow[]> {
    return this.refunds.aggregate<TrendRow>([
      {
        $match: {
          status: RefundStatus.Succeeded,
          processedAt: { $gte: period.from, $lt: period.toExclusive },
        },
      },
      { $group: { _id: this.dateKey('$processedAt', period), value: { $sum: '$amountInPaise' } } },
    ]);
  }

  private customerTrend(period: ResolvedAnalyticsPeriod): Promise<TrendRow[]> {
    return this.customers.aggregate<TrendRow>([
      { $match: { createdAt: { $gte: period.from, $lt: period.toExclusive } } },
      { $group: { _id: this.dateKey('$createdAt', period), value: { $sum: 1 } } },
    ]);
  }

  private topProducts(period: ResolvedAnalyticsPeriod): Promise<TopProductRow[]> {
    return this.payments.aggregate<TopProductRow>([
      {
        $match: {
          status: PaymentAttemptStatus.Captured,
          capturedAt: { $gte: period.from, $lt: period.toExclusive },
        },
      },
      { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
      { $unwind: '$order' },
      { $unwind: '$order.items' },
      {
        $group: {
          _id: '$order.items.productId',
          name: { $first: '$order.items.productName' },
          slug: { $first: '$order.items.productSlug' },
          unitsSold: { $sum: '$order.items.quantity' },
          itemSalesInPaise: { $sum: '$order.items.lineTotalInPaise' },
        },
      },
      { $sort: { itemSalesInPaise: -1, unitsSold: -1, _id: 1 } },
      { $limit: 10 },
    ]);
  }

  private lowStock(): Promise<LowStockRow[]> {
    return this.inventory.aggregate<LowStockRow>([
      { $set: { available: { $subtract: ['$onHand', '$reserved'] } } },
      { $match: { $expr: { $lte: ['$available', '$reorderPoint'] } } },
      {
        $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' },
      },
      { $unwind: '$product' },
      {
        $match: {
          'product.status': { $ne: ProductStatus.Archived },
          'product.visibility': { $ne: 'REPAIR_INTERNAL' },
        },
      },
      {
        $set: {
          variant: {
            $first: {
              $filter: {
                input: '$product.variants',
                as: 'variant',
                cond: { $eq: ['$$variant.variantId', '$variantId'] },
              },
            },
          },
        },
      },
      { $match: { 'variant.isActive': true } },
      {
        $project: {
          productId: 1,
          productName: '$product.name',
          variantId: 1,
          variantTitle: '$variant.title',
          sku: 1,
          available: 1,
          reorderPoint: 1,
        },
      },
      { $sort: { available: 1, reorderPoint: -1, sku: 1 } },
      { $limit: 20 },
    ]);
  }

  private mergeTrend(
    period: ResolvedAnalyticsPeriod,
    payments: TrendRow[],
    refunds: TrendRow[],
    customers: TrendRow[],
  ): AnalyticsTrendPoint[] {
    const paymentMap = new Map(payments.map((row) => [row._id, row]));
    const refundMap = new Map(refunds.map((row) => [row._id, row.value]));
    const customerMap = new Map(customers.map((row) => [row._id, row.value]));
    return analyticsBucketKeys(period).map((key) => {
      const grossSalesInPaise = paymentMap.get(key)?.value ?? 0;
      const refundsInPaise = refundMap.get(key) ?? 0;
      return {
        key,
        grossSalesInPaise,
        refundsInPaise,
        netRevenueInPaise: grossSalesInPaise - refundsInPaise,
        orders: paymentMap.get(key)?.count ?? 0,
        newCustomers: customerMap.get(key) ?? 0,
      };
    });
  }

  private dateKey(field: string, period: ResolvedAnalyticsPeriod): Record<string, unknown> {
    return {
      $dateToString: {
        date: field,
        format: analyticsBucketFormat(period.granularity),
        timezone: period.timezone,
      },
    };
  }

  private rupees(paise: number): string {
    return (paise / 100).toFixed(2);
  }

  private csvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }
}
