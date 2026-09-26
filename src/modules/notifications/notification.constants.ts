export const NOTIFICATION_QUEUE = 'notification-delivery';
export const PROCESS_NOTIFICATIONS_JOB = 'process-notifications';
export const PROCESS_NOTIFICATIONS_SCHEDULER = 'process-notifications-v1';
export const NOTIFICATION_SWEEP_MS = 15_000;
export const NOTIFICATION_BATCH_SIZE = 50;
export const NOTIFICATION_MAX_ATTEMPTS = 8;
export const NOTIFICATION_LEASE_MS = 5 * 60_000;
export const NOTIFICATION_RETRY_BASE_MS = 30_000;
