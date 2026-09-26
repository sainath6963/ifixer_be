import type { DatabaseMigration } from './migration';

export const adminBusinessAnalyticsMigration: DatabaseMigration = {
  id: '020-admin-business-analytics',
  description: 'Add bounded date-range analytics indexes for payments, refunds, and customers',
  async up(context): Promise<void> {
    await context.connection.model('PaymentAttempt').createIndexes();
    await context.connection.model('Refund').createIndexes();
    await context.connection.model('Customer').createIndexes();
  },
};
