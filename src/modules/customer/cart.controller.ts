import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { getAuthRequestContext } from '../admin-auth/http-context';
import { readRequestCookie } from '../admin-auth/cookie.util';
import { CartService } from './cart.service';
import type { CartIdentity, CartOperationResult, CartView } from './cart.types';
import { CustomerCookieService } from './customer-cookie.service';
import { CUSTOMER_ACCESS_SECURITY, CUSTOMER_CART_COOKIE } from './customer.constants';
import { CustomerCsrfGuard } from './customer-csrf.guard';
import type { CustomerRequest } from './customer.types';
import { CartMutationVersionDto, CartVariantParamDto, SetCartItemDto } from './dto/cart.dto';
import { OptionalCustomerGuard } from './optional-customer.guard';

@ApiTags('customer-cart')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('cart')
@UseGuards(CustomerCsrfGuard, OptionalCustomerGuard)
export class CartController {
  constructor(
    private readonly carts: CartService,
    private readonly cookies: CustomerCookieService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get the authenticated or guest cart with current catalog pricing' })
  async get(@Req() request: CustomerRequest): Promise<{ cart: CartView }> {
    return { cart: (await this.carts.get(this.identity(request))).cart };
  }

  @Put('items/:variantId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Set exact variant quantity using server-authoritative price and stock',
  })
  async setItem(
    @Param() params: CartVariantParamDto,
    @Body() input: SetCartItemDto,
    @Req() request: CustomerRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ cart: CartView }> {
    return this.respond(
      await this.carts.setItem(
        this.identity(request),
        params.variantId,
        input,
        getAuthRequestContext(request),
      ),
      response,
    );
  }

  @Delete('items/:variantId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Remove one variant from the cart' })
  async removeItem(
    @Param() params: CartVariantParamDto,
    @Body() input: CartMutationVersionDto,
    @Req() request: CustomerRequest,
  ): Promise<{ cart: CartView }> {
    return {
      cart: (
        await this.carts.removeItem(
          this.identity(request),
          params.variantId,
          input,
          getAuthRequestContext(request),
        )
      ).cart,
    };
  }

  @Delete()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Remove every item from the current cart' })
  async clear(
    @Body() input: CartMutationVersionDto,
    @Req() request: CustomerRequest,
  ): Promise<{ cart: CartView }> {
    return {
      cart: (await this.carts.clear(this.identity(request), input, getAuthRequestContext(request)))
        .cart,
    };
  }

  private identity(request: CustomerRequest): CartIdentity {
    return {
      customerId: request.customer?.id,
      guestToken: request.customer ? undefined : readRequestCookie(request, CUSTOMER_CART_COOKIE),
    };
  }

  private respond(result: CartOperationResult, response: Response): { cart: CartView } {
    if (result.guestTokenToSet) {
      this.cookies.setGuestCartCookie(response, result.guestTokenToSet);
    }
    return { cart: result.cart };
  }
}
