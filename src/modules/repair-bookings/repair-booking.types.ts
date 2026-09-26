import type { RepairBookingStatus, RepairPricingMode } from '../../database/schemas/repair.schema';
export interface RepairBookingView {
  jobNumber?: string;
  reference: string;
  customerName: string;
  phone: string;
  email?: string;
  deviceLabel: string;
  serviceLabel: string;
  issue: string;
  pricingMode: RepairPricingMode;
  indicativePriceInPaise?: number;
  requestedVisitAt?: Date;
  confirmedVisitAt?: Date;
  status: RepairBookingStatus;
  version: number;
  createdAt: Date;
  history: Array<{
    at: Date;
    action: string;
    status: RepairBookingStatus;
    reason: string;
    visitAt?: Date;
    actor?: string;
    actorId?: string;
  }>;
  source?: string;
  customerId?: string;
  brandId?: string;
  modelId?: string;
  serviceId?: string;
}
export interface RepairBookingPage {
  items: RepairBookingView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
