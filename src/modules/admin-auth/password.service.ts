import { Injectable, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

@Injectable()
export class PasswordService implements OnModuleInit {
  private dummyHash?: string;

  async onModuleInit(): Promise<void> {
    this.dummyHash = await this.hash(randomBytes(32).toString('base64url'));
  }

  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async verifyAgainstDummy(password: string): Promise<void> {
    if (!this.dummyHash) {
      this.dummyHash = await this.hash(randomBytes(32).toString('base64url'));
    }
    await this.verify(this.dummyHash, password);
  }

  needsRehash(passwordHash: string): boolean {
    return argon2.needsRehash(passwordHash, {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  }
}
