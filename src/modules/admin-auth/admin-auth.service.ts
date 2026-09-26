import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import {
  AdminSession,
  AdminSessionDocument,
  AdminUser,
  AdminUserDocument,
} from '../../database/schemas/identity.schema';
import { AccountStatus } from '../../domain/enums';
import { AuthAuditService } from './auth-audit.service';
import type {
  AdminView,
  AuthenticatedAdmin,
  AuthRequestContext,
  AuthResult,
  VerifiedSessionToken,
} from './auth.types';
import { PasswordService } from './password.service';
import { AdminTokenService } from './token.service';

class RefreshRotationConflictError extends Error {}
class AdminUnavailableError extends Error {}

@Injectable()
export class AdminAuthService {
  private readonly refreshTtlSeconds: number;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(AdminUser.name) private readonly adminUsers: Model<AdminUser>,
    @InjectModel(AdminSession.name) private readonly adminSessions: Model<AdminSession>,
    private readonly passwords: PasswordService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AuthAuditService,
    config: ConfigService,
  ) {
    this.refreshTtlSeconds = config.getOrThrow<number>('JWT_REFRESH_TTL_SECONDS');
  }

  async login(
    emailInput: string,
    password: string,
    context: AuthRequestContext,
  ): Promise<AuthResult> {
    const email = emailInput.trim().toLowerCase();
    const admin = await this.adminUsers.findOne({ email }).select('+passwordHash').exec();

    if (!admin) {
      await this.passwords.verifyAgainstDummy(password);
      await this.recordFailedLogin(email, context);
      throw this.invalidCredentials();
    }

    const passwordMatches = await this.passwords.verify(admin.passwordHash, password);
    if (!passwordMatches || admin.status !== AccountStatus.Active) {
      await this.recordFailedLogin(email, context);
      throw this.invalidCredentials();
    }

    const sessionId = new Types.ObjectId();
    const issued = await this.tokens.issue(admin.id, sessionId.toHexString(), 0);
    const now = new Date();
    const expiresAt = this.refreshExpiryFrom(now);
    const upgradedPasswordHash = this.passwords.needsRehash(admin.passwordHash)
      ? await this.passwords.hash(password)
      : undefined;

    try {
      await this.connection.transaction(async (databaseSession): Promise<void> => {
        const currentAdmin = await this.adminUsers
          .findOneAndUpdate(
            { _id: admin._id, status: AccountStatus.Active },
            {
              $set: {
                lastLoginAt: now,
                ...(upgradedPasswordHash ? { passwordHash: upgradedPasswordHash } : {}),
              },
            },
            { session: databaseSession, returnDocument: 'after' },
          )
          .exec();
        if (!currentAdmin) {
          throw new AdminUnavailableError();
        }

        await this.adminSessions.create(
          [
            {
              _id: sessionId,
              adminUserId: admin._id,
              tokenHash: this.tokens.hashRefreshToken(issued.refreshToken),
              refreshGeneration: 0,
              expiresAt,
              ipHash: this.tokens.hashSensitiveValue(context.ipAddress),
              userAgent: context.userAgent,
            },
          ],
          { session: databaseSession },
        );
        await this.audit.record(
          {
            action: 'ADMIN_LOGIN_SUCCEEDED',
            resourceType: 'ADMIN_SESSION',
            resourceId: sessionId.toHexString(),
            actorId: admin.id,
            context,
          },
          databaseSession,
        );
      });
    } catch (error: unknown) {
      if (error instanceof AdminUnavailableError) {
        throw this.invalidCredentials();
      }
      throw error;
    }

    return { ...issued, admin: this.toAdminView(admin) };
  }

  async authenticateAccess(accessToken: string): Promise<AuthenticatedAdmin> {
    const verified = await this.tokens.verifyAccess(accessToken);
    const now = new Date();
    const session = await this.adminSessions
      .findOne({
        _id: verified.sessionId,
        adminUserId: verified.adminId,
        refreshGeneration: verified.generation,
        revokedAt: { $exists: false },
        expiresAt: { $gt: now },
      })
      .exec();
    if (!session) {
      throw this.invalidSession();
    }

    const admin = await this.adminUsers
      .findOne({ _id: verified.adminId, status: AccountStatus.Active })
      .exec();
    if (!admin) {
      throw this.invalidSession();
    }

    return { ...this.toAdminView(admin), sessionId: session.id };
  }

  async refresh(refreshToken: string, context: AuthRequestContext): Promise<AuthResult> {
    const verified = await this.tokens.verifyRefresh(refreshToken);
    const presentedHash = this.tokens.hashRefreshToken(refreshToken);
    const existing = await this.adminSessions
      .findById(verified.sessionId)
      .select('+tokenHash')
      .exec();

    if (
      !existing ||
      existing.adminUserId.toHexString() !== verified.adminId ||
      existing.revokedAt ||
      existing.expiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidSession();
    }

    if (
      existing.refreshGeneration !== verified.generation ||
      !this.tokens.tokenHashesMatch(existing.tokenHash, presentedHash)
    ) {
      await this.revokeForRefreshReuse(existing, context);
      throw this.invalidSession();
    }

    const nextGeneration = verified.generation + 1;
    const issued = await this.tokens.issue(verified.adminId, verified.sessionId, nextGeneration);
    const now = new Date();

    try {
      const admin = await this.connection.transaction(
        async (databaseSession): Promise<AdminUserDocument> => {
          const rotated = await this.adminSessions
            .findOneAndUpdate(
              {
                _id: existing._id,
                adminUserId: existing.adminUserId,
                tokenHash: presentedHash,
                refreshGeneration: verified.generation,
                revokedAt: { $exists: false },
                expiresAt: { $gt: now },
              },
              {
                $set: {
                  tokenHash: this.tokens.hashRefreshToken(issued.refreshToken),
                  refreshGeneration: nextGeneration,
                  expiresAt: this.refreshExpiryFrom(now),
                  lastUsedAt: now,
                  ipHash: this.tokens.hashSensitiveValue(context.ipAddress),
                  userAgent: context.userAgent,
                },
              },
              { session: databaseSession, returnDocument: 'after' },
            )
            .exec();
          if (!rotated) {
            throw new RefreshRotationConflictError();
          }

          const currentAdmin = await this.adminUsers
            .findOne({ _id: verified.adminId, status: AccountStatus.Active })
            .session(databaseSession)
            .exec();
          if (!currentAdmin) {
            throw new AdminUnavailableError();
          }

          await this.audit.record(
            {
              action: 'ADMIN_REFRESH_ROTATED',
              resourceType: 'ADMIN_SESSION',
              resourceId: existing.id,
              actorId: currentAdmin.id,
              context,
              metadata: { generation: nextGeneration },
            },
            databaseSession,
          );
          return currentAdmin;
        },
      );

      return { ...issued, admin: this.toAdminView(admin) };
    } catch (error: unknown) {
      if (error instanceof RefreshRotationConflictError) {
        const latest = await this.adminSessions.findById(existing._id).select('+tokenHash').exec();
        if (latest) {
          await this.revokeForRefreshReuse(latest, context);
        }
        throw this.invalidSession();
      }
      if (error instanceof AdminUnavailableError) {
        await this.revokeSession(existing.id, 'ADMIN_UNAVAILABLE', context);
        throw this.invalidSession();
      }
      throw error;
    }
  }

  async logout(refreshToken: string | undefined, context: AuthRequestContext): Promise<void> {
    if (!refreshToken) {
      return;
    }

    let verified: VerifiedSessionToken;
    try {
      verified = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      return;
    }
    await this.revokeSession(verified.sessionId, 'LOGOUT', context, verified.adminId);
  }

  async logoutAll(admin: AuthenticatedAdmin, context: AuthRequestContext): Promise<void> {
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      await this.adminSessions.updateMany(
        { adminUserId: new Types.ObjectId(admin.id), revokedAt: { $exists: false } },
        { $set: { revokedAt: now, revokedReason: 'LOGOUT_ALL' } },
        { session: databaseSession },
      );
      await this.audit.record(
        {
          action: 'ADMIN_LOGOUT_ALL',
          resourceType: 'ADMIN_USER',
          resourceId: admin.id,
          actorId: admin.id,
          context,
        },
        databaseSession,
      );
    });
  }

  async changePassword(
    admin: AuthenticatedAdmin,
    currentPassword: string,
    newPassword: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const currentAdmin = await this.adminUsers
      .findOne({ _id: admin.id, status: AccountStatus.Active })
      .select('+passwordHash')
      .exec();
    if (
      !currentAdmin ||
      !(await this.passwords.verify(currentAdmin.passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException({
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'Current password is incorrect',
      });
    }
    if (await this.passwords.verify(currentAdmin.passwordHash, newPassword)) {
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: 'New password must differ from the current password',
      });
    }

    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      const updated = await this.adminUsers.updateOne(
        { _id: currentAdmin._id, status: AccountStatus.Active },
        { $set: { passwordHash, passwordChangedAt: now } },
        { session: databaseSession },
      );
      if (updated.modifiedCount !== 1) {
        throw new AdminUnavailableError();
      }
      await this.adminSessions.updateMany(
        { adminUserId: currentAdmin._id, revokedAt: { $exists: false } },
        { $set: { revokedAt: now, revokedReason: 'PASSWORD_CHANGED' } },
        { session: databaseSession },
      );
      await this.audit.record(
        {
          action: 'ADMIN_PASSWORD_CHANGED',
          resourceType: 'ADMIN_USER',
          resourceId: admin.id,
          actorId: admin.id,
          context,
        },
        databaseSession,
      );
    });
  }

  private async recordFailedLogin(email: string, context: AuthRequestContext): Promise<void> {
    await this.audit.record({
      action: 'ADMIN_LOGIN_FAILED',
      resourceType: 'ADMIN_AUTH',
      resourceId: this.tokens.hashSensitiveValue(email),
      context,
    });
  }

  private async revokeForRefreshReuse(
    session: AdminSessionDocument,
    context: AuthRequestContext,
  ): Promise<void> {
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      const result = await this.adminSessions.updateOne(
        { _id: session._id, revokedAt: { $exists: false } },
        {
          $set: {
            revokedAt: now,
            revokedReason: 'REFRESH_TOKEN_REUSE',
            reuseDetectedAt: now,
          },
        },
        { session: databaseSession },
      );
      if (result.modifiedCount === 1) {
        await this.audit.record(
          {
            action: 'ADMIN_REFRESH_REUSE_DETECTED',
            resourceType: 'ADMIN_SESSION',
            resourceId: session.id,
            actorId: session.adminUserId.toHexString(),
            context,
          },
          databaseSession,
        );
      }
    });
  }

  private async revokeSession(
    sessionId: string,
    reason: string,
    context: AuthRequestContext,
    expectedAdminId?: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(sessionId)) {
      return;
    }
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      const session = await this.adminSessions
        .findOneAndUpdate(
          {
            _id: sessionId,
            ...(expectedAdminId ? { adminUserId: new Types.ObjectId(expectedAdminId) } : {}),
            revokedAt: { $exists: false },
          },
          { $set: { revokedAt: now, revokedReason: reason } },
          { session: databaseSession, returnDocument: 'after' },
        )
        .exec();
      if (session) {
        await this.audit.record(
          {
            action: 'ADMIN_SESSION_REVOKED',
            resourceType: 'ADMIN_SESSION',
            resourceId: session.id,
            actorId: session.adminUserId.toHexString(),
            context,
            metadata: { reason },
          },
          databaseSession,
        );
      }
    });
  }

  private refreshExpiryFrom(date: Date): Date {
    return new Date(date.getTime() + this.refreshTtlSeconds * 1000);
  }

  private toAdminView(admin: AdminUserDocument): AdminView {
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      roles: admin.roles,
    };
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'ADMIN_CREDENTIALS_INVALID',
      message: 'Invalid email or password',
    });
  }

  private invalidSession(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'ADMIN_SESSION_INVALID',
      message: 'Admin session is invalid or expired',
    });
  }
}
