import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { isEmail } from 'class-validator';
import { Connection, Model, Types } from 'mongoose';

import { AdminUser } from '../schemas/identity.schema';
import { AuditLog, StoreSetting } from '../schemas/operations.schema';
import { AccountStatus, AdminRole, AuditActorType } from '../../domain/enums';
import { PasswordService } from '../../modules/admin-auth/password.service';

const OWNER_BOOTSTRAP_SETTING = 'security.ownerBootstrapped';

@Injectable()
export class AdminBootstrapService {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(AdminUser.name) private readonly adminUsers: Model<AdminUser>,
    @InjectModel(StoreSetting.name) private readonly settings: Model<StoreSetting>,
    @InjectModel(AuditLog.name) private readonly auditLogs: Model<AuditLog>,
    private readonly passwords: PasswordService,
  ) {}

  async run(input: { name: string; email: string; password: string }): Promise<string> {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    this.validate(name, email, input.password);
    const passwordHash = await this.passwords.hash(input.password);
    const adminId = new Types.ObjectId();

    await this.connection.transaction(async (session): Promise<void> => {
      const ownerExists = await this.adminUsers.exists({ roles: AdminRole.Owner }).session(session);
      const bootstrapExists = await this.settings
        .exists({ key: OWNER_BOOTSTRAP_SETTING })
        .session(session);
      if (ownerExists || bootstrapExists) {
        throw new Error('Owner bootstrap refused: an owner or bootstrap marker already exists');
      }

      await this.adminUsers.create(
        [
          {
            _id: adminId,
            name,
            email,
            passwordHash,
            roles: [AdminRole.Owner],
            status: AccountStatus.Active,
            passwordChangedAt: new Date(),
          },
        ],
        { session },
      );
      await this.settings.create(
        [
          {
            key: OWNER_BOOTSTRAP_SETTING,
            value: { completedAt: new Date(), adminUserId: adminId.toHexString() },
            isPublic: false,
            description: 'One-time initial owner bootstrap marker',
            updatedBy: adminId,
          },
        ],
        { session },
      );
      await this.auditLogs.create(
        [
          {
            actorType: AuditActorType.System,
            action: 'INITIAL_OWNER_BOOTSTRAPPED',
            resourceType: 'ADMIN_USER',
            resourceId: adminId.toHexString(),
            metadata: { roles: [AdminRole.Owner] },
            occurredAt: new Date(),
          },
        ],
        { session },
      );
    });

    this.logger.log(`Initial owner created: ${adminId.toHexString()}`);
    return adminId.toHexString();
  }

  private validate(name: string, email: string, password: string): void {
    if (!name || name.length > 120) {
      throw new Error('BOOTSTRAP_ADMIN_NAME must contain 1 to 120 characters');
    }
    if (!isEmail(email) || email.length > 254) {
      throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address');
    }
    if (password.length < 12 || password.length > 128) {
      throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain 12 to 128 characters');
    }
  }
}
