import type { Request } from 'express';

import type { AdminRole } from '../../domain/enums';

export interface AdminView {
  id: string;
  name: string;
  email: string;
  roles: AdminRole[];
}

export interface AuthenticatedAdmin extends AdminView {
  sessionId: string;
}

export interface AuthenticatedAdminRequest extends Request {
  admin?: AuthenticatedAdmin;
}

export interface AuthRequestContext {
  ipAddress: string;
  userAgent?: string;
  requestId?: string;
}

export interface IssuedAuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  refreshExpiresInSeconds: number;
}

export interface AuthResult extends IssuedAuthTokens {
  admin: AdminView;
}

export interface VerifiedSessionToken {
  adminId: string;
  sessionId: string;
  generation: number;
  expiresAt: number;
}
