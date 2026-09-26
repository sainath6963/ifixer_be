import type { Types } from 'mongoose';
import type { RepairPricingMode } from '../../database/schemas/repair.schema';
export interface RepairCatalogEntry {
  id: string;
  name?: string;
  slug?: string;
  active: boolean;
  sortOrder: number;
  description?: string;
  brandId?: string;
  modelId?: string;
  serviceId?: string;
  pricingMode?: RepairPricingMode;
  priceInPaise?: number;
  version: number;
}
export interface RepairCatalogView {
  brands: RepairCatalogEntry[];
  models: RepairCatalogEntry[];
  services: RepairCatalogEntry[];
  options: RepairCatalogEntry[];
}
export interface RepairSelection {
  brandId?: Types.ObjectId;
  modelId?: Types.ObjectId;
  serviceId?: Types.ObjectId;
  deviceLabel: string;
  serviceLabel: string;
  pricingMode: RepairPricingMode;
  indicativePriceInPaise?: number;
}
