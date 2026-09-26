import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Error as MongooseError, Model, Types } from 'mongoose';

import { Customer, CustomerDocument, SavedAddress } from '../../database/schemas/identity.schema';
import { AccountStatus } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerAuditService } from './customer-audit.service';
import type {
  AddressBookView,
  SavedAddressInput,
  SavedAddressView,
} from './customer-address.types';

const ADDRESS_LIMIT = 10;

@Injectable()
export class CustomerAddressService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    private readonly audit: CustomerAuditService,
  ) {}

  async list(customerId: string): Promise<AddressBookView> {
    const customer = await this.customers
      .findOne({ _id: customerId, status: AccountStatus.Active })
      .exec();
    if (!customer) throw this.customerUnavailable();
    return this.toAddressBook(customer);
  }

  async create(
    customerId: string,
    input: SavedAddressInput & { expectedVersion: number; isDefault: boolean },
    context: AuthRequestContext,
  ): Promise<AddressBookView> {
    const addressId = new Types.ObjectId();
    return this.mutate(customerId, input.expectedVersion, async (customer) => {
      if (customer.addresses.length >= ADDRESS_LIMIT) {
        throw new UnprocessableEntityException({
          code: 'ADDRESS_BOOK_LIMIT_REACHED',
          message: `A maximum of ${ADDRESS_LIMIT} saved addresses is allowed`,
        });
      }

      const makeDefault = customer.addresses.length === 0 || input.isDefault;
      if (makeDefault) {
        customer.addresses.forEach((address) => {
          address.isDefault = false;
        });
      }
      const address: SavedAddress = {
        addressId,
        ...this.normalize(input),
        isDefault: makeDefault,
      };
      customer.addresses.push(address);
      await this.recordMutation(customer, 'CUSTOMER_ADDRESS_CREATED', addressId, context);
    });
  }

  async replace(
    customerId: string,
    addressIdInput: string,
    input: SavedAddressInput & { expectedVersion: number },
    context: AuthRequestContext,
  ): Promise<AddressBookView> {
    const addressId = new Types.ObjectId(addressIdInput);
    return this.mutate(customerId, input.expectedVersion, async (customer) => {
      const address = customer.addresses.find((item) => item.addressId.equals(addressId));
      if (!address) throw this.addressNotFound();
      const normalized = this.normalize(input);
      Object.assign(address, normalized);
      address.line2 = normalized.line2;
      await this.recordMutation(customer, 'CUSTOMER_ADDRESS_UPDATED', addressId, context);
    });
  }

  async makeDefault(
    customerId: string,
    addressIdInput: string,
    expectedVersion: number,
    context: AuthRequestContext,
  ): Promise<AddressBookView> {
    const addressId = new Types.ObjectId(addressIdInput);
    return this.mutate(customerId, expectedVersion, async (customer) => {
      if (!customer.addresses.some((item) => item.addressId.equals(addressId))) {
        throw this.addressNotFound();
      }
      customer.addresses.forEach((address) => {
        address.isDefault = address.addressId.equals(addressId);
      });
      await this.recordMutation(customer, 'CUSTOMER_ADDRESS_DEFAULTED', addressId, context);
    });
  }

  async remove(
    customerId: string,
    addressIdInput: string,
    expectedVersion: number,
    context: AuthRequestContext,
  ): Promise<AddressBookView> {
    const addressId = new Types.ObjectId(addressIdInput);
    return this.mutate(customerId, expectedVersion, async (customer) => {
      const index = customer.addresses.findIndex((item) => item.addressId.equals(addressId));
      if (index < 0) throw this.addressNotFound();
      const [removed] = customer.addresses.splice(index, 1);
      if (removed.isDefault && customer.addresses.length > 0) {
        customer.addresses[0].isDefault = true;
      }
      await this.recordMutation(customer, 'CUSTOMER_ADDRESS_DELETED', addressId, context);
    });
  }

  private async mutate(
    customerId: string,
    expectedVersion: number,
    change: (customer: CustomerDocument) => Promise<void>,
  ): Promise<AddressBookView> {
    try {
      const customer = await this.connection.transaction(
        async (databaseSession): Promise<CustomerDocument> => {
          const current = await this.customers
            .findOne({ _id: customerId, status: AccountStatus.Active })
            .session(databaseSession)
            .exec();
          if (!current) throw this.customerUnavailable();
          if (this.versionOf(current) !== expectedVersion) throw this.versionConflict();

          await change(current);
          current.markModified('addresses');
          return current.save({ session: databaseSession });
        },
      );
      return this.toAddressBook(customer);
    } catch (error: unknown) {
      if (error instanceof MongooseError.VersionError) throw this.versionConflict();
      throw error;
    }
  }

  private async recordMutation(
    customer: CustomerDocument,
    action: string,
    addressId: Types.ObjectId,
    context: AuthRequestContext,
  ): Promise<void> {
    const session = customer.$session();
    await this.audit.record(
      {
        action,
        resourceType: 'CUSTOMER_ADDRESS',
        resourceId: addressId.toHexString(),
        actorId: customer.id,
        context,
      },
      session ?? undefined,
    );
  }

  private normalize(input: SavedAddressInput): SavedAddressInput {
    const line2 = input.line2?.trim();
    return {
      label: input.label.trim(),
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      line1: input.line1.trim(),
      ...(line2 ? { line2 } : {}),
      city: input.city.trim(),
      state: input.state.trim(),
      postalCode: input.postalCode.trim(),
      countryCode: 'IN',
    };
  }

  private toAddressBook(customer: CustomerDocument): AddressBookView {
    return {
      version: this.versionOf(customer),
      limit: ADDRESS_LIMIT,
      addresses: customer.addresses.map((address): SavedAddressView => ({
        id: address.addressId.toHexString(),
        label: address.label,
        fullName: address.fullName,
        phone: address.phone,
        line1: address.line1,
        ...(address.line2 ? { line2: address.line2 } : {}),
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        countryCode: 'IN',
        isDefault: address.isDefault,
      })),
    };
  }

  private versionOf(customer: CustomerDocument): number {
    const version: unknown = customer.get('version');
    return typeof version === 'number' ? version : 0;
  }

  private versionConflict(): ConflictException {
    return new ConflictException({
      code: 'ADDRESS_BOOK_VERSION_CONFLICT',
      message: 'The address book changed in another request. Refresh and retry.',
    });
  }

  private addressNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'CUSTOMER_ADDRESS_NOT_FOUND',
      message: 'Saved address was not found',
    });
  }

  private customerUnavailable(): NotFoundException {
    return new NotFoundException({
      code: 'CUSTOMER_UNAVAILABLE',
      message: 'Customer account is unavailable',
    });
  }
}
