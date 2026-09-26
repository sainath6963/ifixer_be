import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import {
  BillingSettingsDto,
  IssueInvoiceDto,
  MoneyDto,
  RefundDto,
  CreditDto,
  DeliveryCreditDto,
  WarrantyFollowupDto,
  InvoiceQueryDto,
} from './repair-billing.dto';
import { RepairBillingService, BillingView } from './repair-billing.service';
@Controller('admin/repair/billing')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception)
export class RepairBillingController {
  constructor(private readonly billing: RepairBillingService) {}
  @Get('settings') @Header('Cache-Control', 'private, no-store') settings(): Promise<BillingView> {
    return this.billing.getSettings();
  }
  @Post('settings') save(
    @Body() input: BillingSettingsDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.saveSettings(input, admin);
  }
  @Get('invoices') @Header('Cache-Control', 'private, no-store') list(
    @Query() query: InvoiceQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.list(query, admin);
  }
}
@Controller('admin/repair/jobs/:number/billing')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception)
export class RepairJobBillingController {
  constructor(private readonly billing: RepairBillingService) {}
  @Get() @Header('Cache-Control', 'private, no-store') get(
    @Param('number') number: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.get(number, admin);
  }
  @Post('invoice') issue(
    @Param('number') number: string,
    @Body() input: IssueInvoiceDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.issue(number, input, admin);
  }
  @Post('payments') pay(
    @Param('number') number: string,
    @Body() input: MoneyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.payment(number, input, admin);
  }
  @Post('refunds') refund(
    @Param('number') number: string,
    @Body() input: RefundDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.refund(number, input, admin);
  }
  @Post('credits') credit(
    @Param('number') number: string,
    @Body() input: CreditDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.credit(number, input, admin);
  }
  @Post('delivery-authorization') authorize(
    @Param('number') number: string,
    @Body() input: DeliveryCreditDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.authorize(number, input, admin);
  }
  @Post('followups') followup(
    @Param('number') number: string,
    @Body() input: WarrantyFollowupDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<BillingView> {
    return this.billing.followup(number, input, admin);
  }
}
