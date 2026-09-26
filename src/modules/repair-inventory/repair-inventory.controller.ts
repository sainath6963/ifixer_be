import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import {
  InventoryQueryDto,
  JobPartActionDto,
  PurchaseCancelDto,
  PurchaseDto,
  ReceiptDto,
  ReservePartDto,
  SparePartDto,
  StockAdjustmentDto,
  SupplierDto,
} from './repair-inventory.dto';
import { RepairInventoryService, InventoryPage, InventoryView } from './repair-inventory.service';

@Controller('admin/repair/inventory')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception, AdminRole.Technician)
export class RepairInventoryController {
  constructor(private readonly inventory: RepairInventoryService) {}
  @Get('parts') @Header('Cache-Control', 'private, no-store') parts(
    @Query() query: InventoryQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryPage> {
    return this.inventory.listParts(query, admin);
  }
  @Get('parts/:id') @Header('Cache-Control', 'private, no-store') part(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.getPart(id, admin);
  }
  @Get('parts/:id/lots') @Header('Cache-Control', 'private, no-store') lots(
    @Param('id') id: string,
    @Query() query: InventoryQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryPage> {
    return this.inventory.listLots(id, query, admin);
  }
  @Post('parts') createPart(
    @Body() input: SparePartDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.savePart(input, admin);
  }
  @Patch('parts/:id') savePart(
    @Param('id') id: string,
    @Body() input: SparePartDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.savePart(input, admin, id);
  }
  @Post('parts/:id/adjustments') adjust(
    @Param('id') id: string,
    @Body() input: StockAdjustmentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.adjust(id, input, admin);
  }
  @Get('suppliers') @Header('Cache-Control', 'private, no-store') suppliers(
    @Query() query: InventoryQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryPage> {
    return this.inventory.listSuppliers(query, admin);
  }
  @Post('suppliers') createSupplier(
    @Body() input: SupplierDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.saveSupplier(input, admin);
  }
  @Patch('suppliers/:id') saveSupplier(
    @Param('id') id: string,
    @Body() input: SupplierDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.saveSupplier(input, admin, id);
  }
  @Get('purchases') @Header('Cache-Control', 'private, no-store') purchases(
    @Query() query: InventoryQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryPage> {
    return this.inventory.listPurchases(query, admin);
  }
  @Post('purchases') createPurchase(
    @Body() input: PurchaseDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.createPurchase(input, admin);
  }
  @Get('purchases/:id') @Header('Cache-Control', 'private, no-store') purchase(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.getPurchase(id, admin);
  }
  @Post('purchases/:id/receipts') receive(
    @Param('id') id: string,
    @Body() input: ReceiptDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.receive(id, input, admin);
  }
  @Post('purchases/:id/cancel') cancel(
    @Param('id') id: string,
    @Body() input: PurchaseCancelDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.cancelPurchase(id, input, admin);
  }
  @Get('movements') @Header('Cache-Control', 'private, no-store') movements(
    @Query() query: InventoryQueryDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryPage> {
    return this.inventory.listMovements(query, admin);
  }
}

@Controller('admin/repair/jobs/:number/parts')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception, AdminRole.Technician)
export class RepairJobPartsController {
  constructor(private readonly inventory: RepairInventoryService) {}
  @Get() @Header('Cache-Control', 'private, no-store') list(
    @Param('number') number: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.jobParts(number, admin);
  }
  @Post() reserve(
    @Param('number') number: string,
    @Body() input: ReservePartDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.reserve(number, input, admin);
  }
  @Post(':id') change(
    @Param('number') number: string,
    @Param('id') id: string,
    @Body() input: JobPartActionDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ): Promise<InventoryView> {
    return this.inventory.usePart(number, id, input, admin);
  }
}
