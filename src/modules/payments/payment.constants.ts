export const RAZORPAY_GATEWAY = Symbol('RAZORPAY_GATEWAY');
export const PAYMENT_QUEUE = 'payment-maintenance';
export const RECONCILE_PAYMENTS_JOB = 'reconcile-payments';
export const RECONCILE_PAYMENTS_SCHEDULER = 'reconcile-payments-scheduler';
export const PAYMENT_RECONCILIATION_SWEEP_MS = 60_000;
export const PAYMENT_RECONCILIATION_BATCH_SIZE = 50;
export const PAYMENT_RECONCILIATION_MIN_AGE_MS = 15_000;

export const RAZORPAY_PROVIDER_ORDER_PATTERN = /^order_[A-Za-z0-9]{8,92}$/;
export const RAZORPAY_PROVIDER_PAYMENT_PATTERN = /^pay_[A-Za-z0-9]{8,94}$/;
export const RAZORPAY_PROVIDER_REFUND_PATTERN = /^rfnd_[A-Za-z0-9]{8,93}$/;
export const RAZORPAY_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;
export const RAZORPAY_EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;
export const RAZORPAY_REFUND_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
