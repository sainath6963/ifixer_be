import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  const requiredEnvironment = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017/rich_culture',
    REDIS_HOST: '127.0.0.1',
    JWT_ACCESS_SECRET: 'test-access-secret-32-characters-minimum',
    JWT_REFRESH_SECRET: 'test-refresh-secret-32-characters-minimum',
    AUTH_TOKEN_PEPPER: 'test-token-pepper-32-characters-minimum',
    CUSTOMER_JWT_ACCESS_SECRET: 'test-customer-access-secret-32-characters-minimum',
    CUSTOMER_JWT_REFRESH_SECRET: 'test-customer-refresh-secret-32-characters-minimum',
    CUSTOMER_TOKEN_PEPPER: 'test-customer-token-pepper-32-characters-minimum',
    PUBLIC_STOREFRONT_URL: 'http://localhost:3000',
    CSRF_SECRET: 'test-csrf-secret-32-characters-minimum',
    RAZORPAY_KEY_ID: 'rzp_test_phase8example',
    RAZORPAY_KEY_SECRET: 'test-razorpay-api-secret-32-characters',
    RAZORPAY_WEBHOOK_SECRET: 'test-razorpay-webhook-secret-32-characters',
    OPERATIONS_ALERT_EMAILS: 'operations@richculture.in',
  };

  it('applies safe defaults and converts primitive values', () => {
    const environment = validateEnvironment({
      ...requiredEnvironment,
      PORT: '4100',
      SWAGGER_ENABLED: 'false',
      MONGO_REQUIRE_REPLICA_SET: 'true',
    });

    expect(environment.PORT).toBe(4100);
    expect(environment.SWAGGER_ENABLED).toBe(false);
    expect(environment.MONGO_REQUIRE_REPLICA_SET).toBe(true);
    expect(environment.API_PREFIX).toBe('api/v1');
    expect(environment.CUSTOMER_MOBILE_OTP_TTL_SECONDS).toBe(600);
    expect(environment.CUSTOMER_MOBILE_OTP_MAX_ATTEMPTS).toBe(5);
    expect(environment.MESSAGE_DELIVERY_MODE).toBe('log');
    expect(environment.SMS_DELIVERY_ENABLED).toBe(true);
    expect(environment.WHATSAPP_DELIVERY_ENABLED).toBe(false);
    expect(environment.METRICS_ENABLED).toBe(false);
    expect(environment.MEDIA_MIN_FREE_BYTES).toBe(536_870_912);
  });

  it('rejects an invalid MongoDB URI', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        MONGODB_URI: 'https://example.com/database',
      }),
    ).toThrow('Environment validation failed');
  });

  it('rejects missing required infrastructure configuration', () => {
    expect(() => validateEnvironment({})).toThrow('Environment validation failed');
  });

  it('validates SMTP mode credentials as a pair', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        EMAIL_DELIVERY_MODE: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USERNAME: 'mailer',
      }),
    ).toThrow('SMTP username and password must either both be set or both be empty');
  });

  it('requires provider credentials and channel senders in http message mode', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        MESSAGE_DELIVERY_MODE: 'http',
        SMS_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow('message provider URL and token are required');
  });

  it('requires a strong bearer token when metrics are enabled', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        METRICS_ENABLED: 'true',
        METRICS_BEARER_TOKEN: '',
      }),
    ).toThrow('metrics bearer token is required');
  });

  it('requires protected metrics and an immutable release in production', () => {
    const validProductionEnvironment = {
      ...requiredEnvironment,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'production-access-secret-32-characters-minimum',
      JWT_REFRESH_SECRET: 'production-refresh-secret-32-characters-minimum',
      AUTH_TOKEN_PEPPER: 'production-token-pepper-32-characters-minimum',
      CUSTOMER_JWT_ACCESS_SECRET: 'production-customer-access-secret-32-characters-minimum',
      CUSTOMER_JWT_REFRESH_SECRET: 'production-customer-refresh-secret-32-characters-minimum',
      CUSTOMER_TOKEN_PEPPER: 'production-customer-token-pepper-32-characters-minimum',
      CSRF_SECRET: 'production-csrf-secret-32-characters-minimum',
      RAZORPAY_KEY_SECRET: 'production-razorpay-api-secret-32-characters',
      RAZORPAY_WEBHOOK_SECRET: 'production-razorpay-webhook-secret-32-characters',
      PUBLIC_STOREFRONT_URL: 'https://richculture.example',
      CORS_ORIGINS: 'https://richculture.example',
      TRUST_PROXY_HOPS: '1',
      SWAGGER_ENABLED: 'false',
      COOKIE_SECURE: 'true',
      MEDIA_STORAGE_ROOT: '/var/lib/rich-culture/media',
      EMAIL_DELIVERY_MODE: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      MESSAGE_DELIVERY_MODE: 'http',
      MESSAGE_PROVIDER_URL: 'https://messages.example.com/send',
      MESSAGE_PROVIDER_TOKEN: 'production-message-provider-token-minimum',
      SMS_SENDER: 'RICHCULTURE',
      RATE_LIMIT_STORAGE: 'redis',
    };

    expect(() => validateEnvironment(validProductionEnvironment)).toThrow(
      'production requires metrics to be enabled',
    );
    expect(() =>
      validateEnvironment({
        ...validProductionEnvironment,
        METRICS_ENABLED: 'true',
        METRICS_BEARER_TOKEN: 'production-metrics-token-32-characters-minimum',
      }),
    ).toThrow('production requires an immutable application release identifier');
    expect(
      validateEnvironment({
        ...validProductionEnvironment,
        APP_RELEASE: '2026.08.20-1',
        METRICS_ENABLED: 'true',
        METRICS_BEARER_TOKEN: 'production-metrics-token-32-characters-minimum',
      }).APP_RELEASE,
    ).toBe('2026.08.20-1');
  });

  it('rejects unsafe production proxy, Swagger, CORS, and rate-limit configuration', () => {
    const productionBase = {
      ...requiredEnvironment,
      NODE_ENV: 'production',
      APP_RELEASE: '2026.08.20-1',
      JWT_ACCESS_SECRET: 'production-access-secret-32-characters-minimum',
      JWT_REFRESH_SECRET: 'production-refresh-secret-32-characters-minimum',
      AUTH_TOKEN_PEPPER: 'production-token-pepper-32-characters-minimum',
      CUSTOMER_JWT_ACCESS_SECRET: 'production-customer-access-secret-32-characters-minimum',
      CUSTOMER_JWT_REFRESH_SECRET: 'production-customer-refresh-secret-32-characters-minimum',
      CUSTOMER_TOKEN_PEPPER: 'production-customer-token-pepper-32-characters-minimum',
      CSRF_SECRET: 'production-csrf-secret-32-characters-minimum',
      RAZORPAY_KEY_SECRET: 'production-razorpay-api-secret-32-characters',
      RAZORPAY_WEBHOOK_SECRET: 'production-razorpay-webhook-secret-32-characters',
      PUBLIC_STOREFRONT_URL: 'https://richculture.example',
      CORS_ORIGINS: 'https://richculture.example',
      COOKIE_SECURE: 'true',
      MEDIA_STORAGE_ROOT: '/var/lib/rich-culture/media',
      EMAIL_DELIVERY_MODE: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMS_DELIVERY_ENABLED: 'false',
      METRICS_ENABLED: 'true',
      METRICS_BEARER_TOKEN: 'production-metrics-token-32-characters-minimum',
      RATE_LIMIT_STORAGE: 'redis',
    };

    expect(() => validateEnvironment(productionBase)).toThrow('trusted proxy hop');
    expect(() => validateEnvironment({ ...productionBase, TRUST_PROXY_HOPS: '1' })).toThrow(
      'Swagger must be disabled',
    );
    expect(() =>
      validateEnvironment({
        ...productionBase,
        TRUST_PROXY_HOPS: '1',
        SWAGGER_ENABLED: 'false',
        CORS_ORIGINS: 'http://richculture.example',
      }),
    ).toThrow('CORS origins must be exact HTTPS origins');
    expect(() =>
      validateEnvironment({
        ...productionBase,
        TRUST_PROXY_HOPS: '1',
        SWAGGER_ENABLED: 'false',
        RATE_LIMIT_STORAGE: 'memory',
      }),
    ).toThrow('Redis-backed rate limiting');
  });

  it('rejects log-only email delivery in production', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'production-access-secret-32-characters-minimum',
        JWT_REFRESH_SECRET: 'production-refresh-secret-32-characters-minimum',
        AUTH_TOKEN_PEPPER: 'production-token-pepper-32-characters-minimum',
        CUSTOMER_JWT_ACCESS_SECRET: 'production-customer-access-secret-32-characters-minimum',
        CUSTOMER_JWT_REFRESH_SECRET: 'production-customer-refresh-secret-32-characters-minimum',
        CUSTOMER_TOKEN_PEPPER: 'production-customer-token-pepper-32-characters-minimum',
        CSRF_SECRET: 'production-csrf-secret-32-characters-minimum',
        RAZORPAY_KEY_SECRET: 'production-razorpay-api-secret-32-characters',
        RAZORPAY_WEBHOOK_SECRET: 'production-razorpay-webhook-secret-32-characters',
        COOKIE_SECURE: 'true',
        MEDIA_STORAGE_ROOT: '/var/lib/rich-culture/media',
        EMAIL_DELIVERY_MODE: 'log',
      }),
    ).toThrow('production requires smtp email delivery');
  });

  it('rejects log-only mobile delivery when a production channel is enabled', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'production-access-secret-32-characters-minimum',
        JWT_REFRESH_SECRET: 'production-refresh-secret-32-characters-minimum',
        AUTH_TOKEN_PEPPER: 'production-token-pepper-32-characters-minimum',
        CUSTOMER_JWT_ACCESS_SECRET: 'production-customer-access-secret-32-characters-minimum',
        CUSTOMER_JWT_REFRESH_SECRET: 'production-customer-refresh-secret-32-characters-minimum',
        CUSTOMER_TOKEN_PEPPER: 'production-customer-token-pepper-32-characters-minimum',
        CSRF_SECRET: 'production-csrf-secret-32-characters-minimum',
        RAZORPAY_KEY_SECRET: 'production-razorpay-api-secret-32-characters',
        RAZORPAY_WEBHOOK_SECRET: 'production-razorpay-webhook-secret-32-characters',
        PUBLIC_STOREFRONT_URL: 'https://richculture.example',
        COOKIE_SECURE: 'true',
        MEDIA_STORAGE_ROOT: '/var/lib/rich-culture/media',
        EMAIL_DELIVERY_MODE: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        MESSAGE_DELIVERY_MODE: 'log',
        SMS_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow('production mobile messaging requires http delivery');
  });

  it('rejects production development secrets and insecure cookies', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'dev-only-access-secret-32-characters-minimum',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow('Environment validation failed');
  });

  it('requires an absolute media storage path in production', () => {
    expect(() =>
      validateEnvironment({
        ...requiredEnvironment,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'production-access-secret-32-characters-minimum',
        JWT_REFRESH_SECRET: 'production-refresh-secret-32-characters-minimum',
        AUTH_TOKEN_PEPPER: 'production-token-pepper-32-characters-minimum',
        CUSTOMER_JWT_ACCESS_SECRET: 'production-customer-access-secret-32-characters-minimum',
        CUSTOMER_JWT_REFRESH_SECRET: 'production-customer-refresh-secret-32-characters-minimum',
        CUSTOMER_TOKEN_PEPPER: 'production-customer-token-pepper-32-characters-minimum',
        CSRF_SECRET: 'production-csrf-secret-32-characters-minimum',
        COOKIE_SECURE: 'true',
        MEDIA_STORAGE_ROOT: './media',
      }),
    ).toThrow('media storage path must be absolute');
  });
});
