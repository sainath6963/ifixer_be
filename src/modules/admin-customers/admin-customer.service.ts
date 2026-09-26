import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';

import { Customer, CustomerDocument } from '../../database/schemas/identity.schema';
import { Order } from '../../database/schemas/order.schema';
import { StockAlert, WishlistItem } from '../../database/schemas/wishlist.schema';
import { FinancialStatus } from '../../domain/enums';
import type { AdminCustomerListQueryDto } from './dto/admin-customer.dto';
import type {
  AdminCustomerDetail,
  AdminCustomerListItem,
  AdminCustomerPage,
} from './admin-customer.types';

interface CustomerOrderSummary {
  _id: Types.ObjectId;
  orderCount: number;
  grossPaidInPaise: number;
}

@Injectable()
export class AdminCustomerService {
  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(WishlistItem.name) private readonly wishlist: Model<WishlistItem>,
    @InjectModel(StockAlert.name) private readonly stockAlerts: Model<StockAlert>,
  ) {}

  async list(query: AdminCustomerListQueryDto): Promise<AdminCustomerPage> {
    const filter: QueryFilter<Customer> = {};
    if (query.status) filter.status = query.status;
    const search = query.search?.trim();
    if (search) {
      const pattern = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }, { mobile: pattern }];
    }
    const [documents, total] = await Promise.all([
      this.customers
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.customers.countDocuments(filter).exec(),
    ]);
    const summaries = await this.orderSummaries(documents.map((document) => document._id));
    return {
      items: documents.map((document) => this.toListItem(document, summaries.get(document.id))),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async get(customerId: string): Promise<AdminCustomerDetail> {
    const customer = await this.customers.findById(customerId).exec();
    if (!customer) {
      throw new NotFoundException({
        code: 'ADMIN_CUSTOMER_NOT_FOUND',
        message: 'Customer was not found',
      });
    }
    const [summaryMap, wishlistCount, activeStockAlertCount, recentOrders] = await Promise.all([
      this.orderSummaries([customer._id]),
      this.wishlist.countDocuments({ customerId: customer._id }).exec(),
      this.stockAlerts.countDocuments({ customerId: customer._id, active: true }).exec(),
      this.orders.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(10).exec(),
    ]);
    return {
      ...this.toListItem(customer, summaryMap.get(customer.id)),
      communicationPreferences: {
        marketingEmail: customer.communicationPreferences?.marketingEmail ?? false,
        backInStockEmail: customer.communicationPreferences?.backInStockEmail ?? true,
        orderUpdatesSms: customer.communicationPreferences?.orderUpdatesSms ?? false,
        orderUpdatesWhatsapp: customer.communicationPreferences?.orderUpdatesWhatsapp ?? false,
      },
      savedAddressCount: customer.addresses.length,
      wishlistCount,
      activeStockAlertCount,
      deactivatedAt: this.iso(customer.deactivatedAt),
      deactivationReason: customer.deactivationReason,
      recentOrders: recentOrders.map((order) => ({
        orderNumber: order.orderNumber,
        lifecycleStatus: order.lifecycleStatus,
        financialStatus: order.financialStatus,
        grandTotalInPaise: order.totals.grandTotalInPaise,
        createdAt: this.iso(order.get('createdAt') as Date)!,
      })),
    };
  }

  private async orderSummaries(
    customerIds: Types.ObjectId[],
  ): Promise<Map<string, CustomerOrderSummary>> {
    if (!customerIds.length) return new Map();
    const rows = await this.orders.aggregate<CustomerOrderSummary>([
      { $match: { customerId: { $in: customerIds } } },
      {
        $group: {
          _id: '$customerId',
          orderCount: { $sum: 1 },
          grossPaidInPaise: {
            $sum: {
              $cond: [
                {
                  $in: [
                    '$financialStatus',
                    [FinancialStatus.Paid, FinancialStatus.PartiallyRefunded],
                  ],
                },
                '$totals.grandTotalInPaise',
                0,
              ],
            },
          },
        },
      },
    ]);
    return new Map(rows.map((row) => [row._id.toHexString(), row]));
  }

  private toListItem(
    customer: CustomerDocument,
    summary?: CustomerOrderSummary,
  ): AdminCustomerListItem {
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      mobile: customer.mobile,
      emailVerified: Boolean(customer.emailVerifiedAt),
      mobileVerified: Boolean(customer.mobileVerifiedAt),
      status: customer.status,
      orderCount: summary?.orderCount ?? 0,
      grossPaidInPaise: summary?.grossPaidInPaise ?? 0,
      lastOrderAt: this.iso(customer.lastOrderAt),
      lastLoginAt: this.iso(customer.lastLoginAt),
      createdAt: this.iso(customer.get('createdAt') as Date)!,
    };
  }

  private iso(value?: Date): string | undefined {
    return value?.toISOString();
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
