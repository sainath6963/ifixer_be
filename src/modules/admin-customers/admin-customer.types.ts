import type { AccountStatus, FinancialStatus, OrderLifecycleStatus } from '../../domain/enums';

export interface AdminCustomerListItem {
  id: string;
  name?: string;
  email?: string;
  mobile?: string;
  emailVerified: boolean;
  mobileVerified: boolean;
  status: AccountStatus;
  orderCount: number;
  grossPaidInPaise: number;
  lastOrderAt?: string;
  lastLoginAt?: string;
  createdAt: string;
}

export interface AdminCustomerPage {
  items: AdminCustomerListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AdminCustomerDetail extends AdminCustomerListItem {
  communicationPreferences: {
    marketingEmail: boolean;
    backInStockEmail: boolean;
    orderUpdatesSms: boolean;
    orderUpdatesWhatsapp: boolean;
  };
  savedAddressCount: number;
  wishlistCount: number;
  activeStockAlertCount: number;
  deactivatedAt?: string;
  deactivationReason?: string;
  recentOrders: Array<{
    orderNumber: string;
    lifecycleStatus: OrderLifecycleStatus;
    financialStatus: FinancialStatus;
    grandTotalInPaise: number;
    createdAt: string;
  }>;
}
