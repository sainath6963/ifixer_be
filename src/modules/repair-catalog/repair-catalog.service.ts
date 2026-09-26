import type {
  RepairCatalogEntry,
  RepairCatalogView,
  RepairSelection,
} from './repair-catalog.types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { ClientSession, Connection, Document, Model, Types } from 'mongoose';
import {
  DeviceBrand,
  DeviceModel,
  RepairService,
  RepairServiceOption,
  RepairPricingMode,
} from '../../database/schemas/repair.schema';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { BrandDto, ModelDto, OptionDto, ServiceDto } from './repair-catalog.dto';

export function catalogView(document: Document<unknown>): RepairCatalogEntry {
  return {
    id: (document._id as Types.ObjectId).toHexString(),
    name: document.get('name') as string | undefined,
    slug: document.get('slug') as string | undefined,
    active: document.get('active') as boolean,
    sortOrder: document.get('sortOrder') as number,
    description: document.get('description') as string | undefined,
    brandId: (document.get('brandId') as Types.ObjectId | undefined)?.toHexString(),
    modelId: (document.get('modelId') as Types.ObjectId | undefined)?.toHexString(),
    serviceId: (document.get('serviceId') as Types.ObjectId | undefined)?.toHexString(),
    pricingMode: document.get('pricingMode') as RepairPricingMode | undefined,
    priceInPaise: document.get('priceInPaise') as number | undefined,
    version: document.get('version') as number,
  };
}

export function validateRepairPrice(mode: RepairPricingMode, amount?: number): void {
  if (
    (mode === RepairPricingMode.Indicative && !Number.isSafeInteger(amount)) ||
    (mode === RepairPricingMode.Diagnosis && amount !== undefined)
  ) {
    throw new BadRequestException({
      code: 'REPAIR_PRICE_INVALID',
      message: 'Indicative pricing needs an amount; diagnosis pricing must not have an amount',
    });
  }
}

@Injectable()
export class RepairCatalogService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(DeviceBrand.name) private readonly brands: Model<DeviceBrand>,
    @InjectModel(DeviceModel.name) private readonly models: Model<DeviceModel>,
    @InjectModel(RepairService.name) private readonly services: Model<RepairService>,
    @InjectModel(RepairServiceOption.name) private readonly options: Model<RepairServiceOption>,
    private readonly audit: AuthAuditService,
  ) {}

  async list(admin = false): Promise<RepairCatalogView> {
    const filter = admin ? {} : { active: true };
    const brands = await this.brands.find(filter).sort({ sortOrder: 1, name: 1, _id: 1 });
    const models = await this.models
      .find(admin ? {} : { active: true, brandId: { $in: brands.map((row) => row._id) } })
      .sort({ sortOrder: 1, name: 1, _id: 1 });
    const services = await this.services.find(filter).sort({ sortOrder: 1, name: 1, _id: 1 });
    const options = await this.options
      .find(
        admin
          ? {}
          : {
              active: true,
              modelId: { $in: models.map((row) => row._id) },
              serviceId: { $in: services.map((row) => row._id) },
            },
      )
      .sort({ sortOrder: 1, _id: 1 });
    return {
      brands: brands.map(catalogView),
      models: models.map(catalogView),
      services: services.map(catalogView),
      options: options.map(catalogView),
    };
  }

  saveBrand(
    input: BrandDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
    id?: string,
  ): Promise<RepairCatalogEntry> {
    return this.save(this.brands, input, admin, context, id);
  }
  saveModel(
    input: ModelDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
    id?: string,
  ): Promise<RepairCatalogEntry> {
    return this.save(this.models, input, admin, context, id, async (session) => {
      if (
        !(await this.brands
          .exists({
            _id: new Types.ObjectId(input.brandId),
            ...(input.active ? { active: true } : {}),
          })
          .session(session))
      )
        this.invalidReference();
    });
  }
  saveService(
    input: ServiceDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
    id?: string,
  ): Promise<RepairCatalogEntry> {
    validateRepairPrice(input.pricingMode, input.priceInPaise);
    return this.save(this.services, input, admin, context, id);
  }
  saveOption(
    input: OptionDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
    id?: string,
  ): Promise<RepairCatalogEntry> {
    validateRepairPrice(input.pricingMode, input.priceInPaise);
    return this.save(this.options, input, admin, context, id, async (session) => {
      const active = input.active ? { active: true } : {};
      const model = await this.models
        .findOne({ _id: new Types.ObjectId(input.modelId), ...active })
        .session(session);
      if (
        !model ||
        !(await this.brands.exists({ _id: model.brandId, ...active }).session(session)) ||
        !(await this.services
          .exists({ _id: new Types.ObjectId(input.serviceId), ...active })
          .session(session))
      )
        this.invalidReference();
    });
  }

  async resolveSelection(
    input: { brandId?: string; modelId?: string; serviceId?: string; deviceDescription?: string },
    session: ClientSession,
  ): Promise<RepairSelection> {
    const brand = input.brandId
      ? await this.brands
          .findOne({ _id: new Types.ObjectId(input.brandId), active: true })
          .session(session)
      : null;
    const model = input.modelId
      ? await this.models
          .findOne({ _id: new Types.ObjectId(input.modelId), brandId: brand?._id, active: true })
          .session(session)
      : null;
    const service = input.serviceId
      ? await this.services
          .findOne({ _id: new Types.ObjectId(input.serviceId), active: true })
          .session(session)
      : null;
    if ((input.brandId && !brand) || (input.modelId && !model) || (input.serviceId && !service))
      this.invalidReference();
    if (!model && !input.deviceDescription?.trim())
      throw new BadRequestException({
        code: 'DEVICE_DESCRIPTION_REQUIRED',
        message: 'Describe your phone if its model is not listed',
      });
    const option =
      model && service
        ? await this.options
            .findOne({ modelId: model._id, serviceId: service._id, active: true })
            .session(session)
        : null;
    if (model && service && !option)
      throw new ConflictException({
        code: 'REPAIR_NOT_COMPATIBLE',
        message:
          'This repair is not listed for the selected model. Choose Other issue for an assessment.',
      });
    return {
      brandId: brand?._id,
      modelId: model?._id,
      serviceId: service?._id,
      deviceLabel: model
        ? `${brand?.name} ${model.name}`
        : [brand?.name, input.deviceDescription?.trim()].filter(Boolean).join(' — '),
      serviceLabel: service?.name ?? 'Other issue / diagnosis',
      pricingMode: option?.pricingMode ?? RepairPricingMode.Diagnosis,
      indicativePriceInPaise: option?.priceInPaise,
    };
  }

  private async save<T>(
    model: Model<T>,
    input: BrandDto | ModelDto | ServiceDto | OptionDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
    id?: string,
    validate?: (session: ClientSession) => Promise<void>,
  ): Promise<RepairCatalogEntry> {
    if (id && !Types.ObjectId.isValid(id)) throw new NotFoundException('Catalog entry not found');
    if (id && input.expectedVersion === undefined)
      throw new BadRequestException('expectedVersion is required');
    const { expectedVersion, ...values } = input;
    try {
      return await this.connection.transaction(async (session) => {
        await validate?.(session);
        const document = id
          ? await model.findOneAndUpdate(
              { _id: new Types.ObjectId(id), version: expectedVersion },
              {
                $set: values,
                $inc: { version: 1 },
                ...('pricingMode' in values && values.pricingMode === RepairPricingMode.Diagnosis
                  ? { $unset: { priceInPaise: 1 } }
                  : {}),
              },
              { returnDocument: 'after', session, runValidators: true },
            )
          : await new model(values).save({ session });
        if (!document)
          throw new ConflictException({
            code: 'REPAIR_CATALOG_CHANGED',
            message: 'The entry changed. Reload before saving again.',
          });
        await this.audit.record(
          {
            action: id ? 'REPAIR_CATALOG_UPDATED' : 'REPAIR_CATALOG_CREATED',
            resourceType: 'REPAIR_CATALOG',
            resourceId: String(document._id),
            actorId: admin.id,
            context,
            metadata: { kind: model.modelName },
          },
          session,
        );
        return catalogView(document);
      });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictException({
          code: 'REPAIR_CATALOG_DUPLICATE',
          message: 'That slug or model/service combination already exists',
        });
      throw error;
    }
  }

  private invalidReference(): never {
    throw new ConflictException({
      code: 'REPAIR_CATALOG_UNAVAILABLE',
      message: 'A selected brand, model or service is unavailable. Refresh your selections.',
    });
  }
}
