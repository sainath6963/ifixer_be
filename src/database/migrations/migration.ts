import type { Connection } from 'mongoose';
import type { Db } from 'mongodb';

export interface MigrationContext {
  connection: Connection;
  database: Db;
}

export interface DatabaseMigration {
  id: string;
  description: string;
  up(context: MigrationContext): Promise<void>;
}
