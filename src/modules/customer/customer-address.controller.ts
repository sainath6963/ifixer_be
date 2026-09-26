import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { getAuthRequestContext } from '../admin-auth/http-context';
import { CustomerAccessGuard } from './customer-access.guard';
import { CustomerAddressService } from './customer-address.service';
import type { AddressBookView } from './customer-address.types';
import { CUSTOMER_ACCESS_SECURITY } from './customer.constants';
import { CustomerCsrfGuard } from './customer-csrf.guard';
import type { AuthenticatedCustomer } from './customer.types';
import { CurrentCustomer } from './current-customer.decorator';
import {
  AddressBookMutationDto,
  CreateSavedAddressDto,
  CustomerAddressIdParamDto,
  ReplaceSavedAddressDto,
} from './dto/customer-address.dto';

@ApiTags('customer-addresses')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/addresses')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class CustomerAddressController {
  constructor(private readonly addresses: CustomerAddressService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List the current customer saved-address book' })
  @ApiOkResponse()
  list(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<AddressBookView> {
    return this.addresses.list(customer.id);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a saved address with optimistic concurrency' })
  @ApiCreatedResponse()
  create(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: CreateSavedAddressDto,
    @Req() request: Request,
  ): Promise<AddressBookView> {
    return this.addresses.create(customer.id, input, getAuthRequestContext(request));
  }

  @Put(':addressId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Replace a saved address with optimistic concurrency' })
  @ApiOkResponse()
  replace(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerAddressIdParamDto,
    @Body() input: ReplaceSavedAddressDto,
    @Req() request: Request,
  ): Promise<AddressBookView> {
    return this.addresses.replace(
      customer.id,
      params.addressId,
      input,
      getAuthRequestContext(request),
    );
  }

  @Post(':addressId/default')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Make a saved address the default' })
  @ApiOkResponse()
  makeDefault(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerAddressIdParamDto,
    @Body() input: AddressBookMutationDto,
    @Req() request: Request,
  ): Promise<AddressBookView> {
    return this.addresses.makeDefault(
      customer.id,
      params.addressId,
      input.expectedVersion,
      getAuthRequestContext(request),
    );
  }

  @Delete(':addressId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Delete a saved address and promote a new default when required' })
  @ApiOkResponse()
  remove(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerAddressIdParamDto,
    @Body() input: AddressBookMutationDto,
    @Req() request: Request,
  ): Promise<AddressBookView> {
    return this.addresses.remove(
      customer.id,
      params.addressId,
      input.expectedVersion,
      getAuthRequestContext(request),
    );
  }
}
