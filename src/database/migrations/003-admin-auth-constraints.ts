import type { DatabaseMigration } from './migration';

export const adminAuthConstraintsMigration: DatabaseMigration = {
  id: '003-admin-auth-constraints',
  description: 'Apply admin identity and refresh-session database validators',
  async up({ connection, database }): Promise<void> {
    await connection.model('AdminUser').createIndexes();
    await connection.model('AdminSession').createIndexes();

    await database.command({
      collMod: 'admin_users',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['name', 'email', 'passwordHash', 'roles', 'status'],
          properties: {
            name: { bsonType: 'string', minLength: 1, maxLength: 120 },
            email: { bsonType: 'string', minLength: 3, maxLength: 254 },
            passwordHash: { bsonType: 'string', minLength: 20 },
            roles: {
              bsonType: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { enum: ['OWNER', 'STAFF'] },
            },
            status: { enum: ['ACTIVE', 'DISABLED'] },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await database.command({
      collMod: 'admin_sessions',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['adminUserId', 'tokenHash', 'refreshGeneration', 'expiresAt'],
              properties: {
                adminUserId: { bsonType: 'objectId' },
                tokenHash: { bsonType: 'string', minLength: 64, maxLength: 64 },
                refreshGeneration: { bsonType: 'number', minimum: 0 },
                expiresAt: { bsonType: 'date' },
                revokedAt: { bsonType: 'date' },
                reuseDetectedAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $eq: [{ $trunc: '$refreshGeneration' }, '$refreshGeneration'],
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
