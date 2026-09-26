import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AuthAuditService } from './auth-audit.service';
import { AdminCookieService } from './cookie.service';
import { CsrfGuard } from './csrf.guard';
import { CsrfService } from './csrf.service';
import { PasswordService } from './password.service';
import { AdminRolesGuard } from './roles.guard';
import { AdminTokenService } from './token.service';

@Module({
  imports: [CorePersistenceModule, JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [
    AdminAuthService,
    AdminAccessGuard,
    AdminRolesGuard,
    AuthAuditService,
    AdminCookieService,
    CsrfGuard,
    CsrfService,
    PasswordService,
    AdminTokenService,
  ],
  exports: [
    AdminAccessGuard,
    AdminRolesGuard,
    CsrfGuard,
    CsrfService,
    AdminCookieService,
    AdminAuthService,
    AuthAuditService,
    PasswordService,
  ],
})
export class AdminAuthModule {}
