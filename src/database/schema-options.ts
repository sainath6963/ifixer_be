import type { SchemaOptions } from 'mongoose';

export const rootSchemaOptions: SchemaOptions = {
  timestamps: true,
  optimisticConcurrency: true,
  versionKey: 'version',
  strict: 'throw',
  minimize: false,
};

export const embeddedSchemaOptions: SchemaOptions = {
  _id: false,
  id: false,
  strict: 'throw',
  minimize: false,
};
