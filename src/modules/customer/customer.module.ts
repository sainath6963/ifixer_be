import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { CustomerAddressController } from './customer-address.controller';
import { CustomerAddressService } from './customer-address.service';
import { CustomerAccessGuard } from './customer-access.guard';
import { CustomerAccountRecoveryService } from './customer-account-recovery.service';
import { CustomerAuditService } from './customer-audit.service';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerCookieService } from './customer-cookie.service';
import { CustomerCsrfGuard } from './customer-csrf.guard';
import { CustomerCsrfService } from './customer-csrf.service';
import { CustomerTokenService } from './customer-token.service';
import { CustomerProfileController } from './customer-profile.controller';
import { CustomerProfileService } from './customer-profile.service';
import { OptionalCustomerGuard } from './optional-customer.guard';

@Module({
  imports: [CorePersistenceModule, JwtModule.register({}), AdminAuthModule],
  controllers: [
    CustomerAuthController,
    CustomerProfileController,
    CustomerAddressController,
    CartController,
  ],
  providers: [
    CustomerTokenService,
    CustomerCookieService,
    CustomerCsrfService,
    CustomerCsrfGuard,
    CustomerAuditService,
    CustomerAccountRecoveryService,
    CustomerAuthService,
    CustomerProfileService,
    CustomerAddressService,
    CustomerAccessGuard,
    OptionalCustomerGuard,
    CartService,
  ],
  exports: [
    CustomerAccessGuard,
    CustomerAuthService,
    CustomerCsrfGuard,
    CustomerCsrfService,
    CustomerAuditService,
    CartService,
  ],
})
export class CustomerModule {}
