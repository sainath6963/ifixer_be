import type { Request } from 'express';

export interface CustomerView {
  id: string;
  name?: string;
  email?: string;
  mobile?: string;
  emailVerified: boolean;
  mobileVerified: boolean;
  version: number;
  communicationPreferences: {
    marketingEmail: boolean;
    backInStockEmail: boolean;
    orderUpdatesSms: boolean;
    orderUpdatesWhatsapp: boolean;
  };
}

export interface AuthenticatedCustomer extends CustomerView {
  sessionId: string;
}

export interface CustomerRequest extends Request {
  customer?: AuthenticatedCustomer;
}

export interface IssuedCustomerTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  refreshExpiresInSeconds: number;
}

export interface CustomerAuthResult extends IssuedCustomerTokens {
  customer: CustomerView;
}

export interface VerifiedCustomerToken {
  customerId: string;
  sessionId: string;
  generation: number;
  expiresAt: number;
}
