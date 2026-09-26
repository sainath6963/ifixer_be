import Joi from 'joi';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface EnvironmentVariables extends Record<string, unknown> {
  NODE_ENV: NodeEnvironment;
  APP_RELEASE: string;
  PORT: number;
  API_PREFIX: string;
  TRUST_PROXY_HOPS: number;
  CORS_ORIGINS: string;
  SWAGGER_ENABLED: boolean;
  MONGODB_URI: string;
  MONGO_REQUIRE_REPLICA_SET: boolean;
  MONGO_SERVER_SELECTION_TIMEOUT_MS: number;
  MONGO_MAX_POOL_SIZE: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_USERNAME: string;
  REDIS_PASSWORD: string;
  REDIS_DB: number;
  REDIS_TLS: boolean;
  QUEUE_PREFIX: string;
  THROTTLE_TTL_MS: number;
  THROTTLE_LIMIT: number;
  RATE_LIMIT_STORAGE: 'memory' | 'redis';
  RATE_LIMIT_KEY_PREFIX: string;
  LOG_LEVEL: string;
  METRICS_ENABLED: boolean;
  METRICS_BEARER_TOKEN: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  JWT_REFRESH_TTL_SECONDS: number;
  AUTH_TOKEN_PEPPER: string;
  CUSTOMER_JWT_ACCESS_SECRET: string;
  CUSTOMER_JWT_REFRESH_SECRET: string;
  CUSTOMER_TOKEN_PEPPER: string;
  CUSTOMER_EMAIL_VERIFICATION_TTL_SECONDS: number;
  CUSTOMER_PASSWORD_RESET_TTL_SECONDS: number;
  CUSTOMER_AUTH_EMAIL_COOLDOWN_SECONDS: number;
  CUSTOMER_MOBILE_OTP_TTL_SECONDS: number;
  CUSTOMER_MOBILE_OTP_COOLDOWN_SECONDS: number;
  CUSTOMER_MOBILE_OTP_MAX_ATTEMPTS: number;
  CUSTOMER_RETURN_WINDOW_DAYS: number;
  EXCHANGE_RESERVATION_TTL_DAYS: number;
  RETURN_EVIDENCE_MAX_FILES: number;
  RETURN_EVIDENCE_MAX_UPLOAD_BYTES: number;
  PUBLIC_STOREFRONT_URL: string;
  CSRF_SECRET: string;
  CSRF_TTL_SECONDS: number;
  COOKIE_SECURE: boolean;
  COOKIE_SAME_SITE: 'strict' | 'lax' | 'none';
  COOKIE_DOMAIN: string;
  MEDIA_STORAGE_ROOT: string;
  MEDIA_MAX_UPLOAD_BYTES: number;
  MEDIA_MAX_INPUT_PIXELS: number;
  MEDIA_WEBP_QUALITY: number;
  MEDIA_STAGING_MAX_AGE_SECONDS: number;
  MEDIA_MIN_FREE_BYTES: number;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
  RAZORPAY_CHECKOUT_NAME: string;
  RAZORPAY_API_TIMEOUT_MS: number;
  EMAIL_DELIVERY_MODE: 'log' | 'smtp';
  EMAIL_FROM_NAME: string;
  EMAIL_FROM_ADDRESS: string;
  OPERATIONS_ALERT_EMAILS: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_REQUIRE_TLS: boolean;
  SMTP_USERNAME: string;
  SMTP_PASSWORD: string;
  SMTP_CONNECTION_TIMEOUT_MS: number;
  SMTP_MAX_CONNECTIONS: number;
  MESSAGE_DELIVERY_MODE: 'log' | 'http';
  SMS_DELIVERY_ENABLED: boolean;
  WHATSAPP_DELIVERY_ENABLED: boolean;
  MESSAGE_PROVIDER_URL: string;
  MESSAGE_PROVIDER_TOKEN: string;
  SMS_SENDER: string;
  WHATSAPP_SENDER: string;
  MESSAGE_PROVIDER_TIMEOUT_MS: number;
}

const environmentSchema = Joi.object<EnvironmentVariables>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  APP_RELEASE: Joi.string()
    .trim()
    .pattern(/^[A-Za-z0-9._-]+$/)
    .max(120)
    .default('local'),
  PORT: Joi.number().port().default(4000),
  API_PREFIX: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9/-]*$/)
    .default('api/v1'),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(10).default(0),
  CORS_ORIGINS: Joi.string().allow('').default('http://localhost:3000'),
  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  MONGODB_URI: Joi.string()
    .pattern(/^mongodb(\+srv)?:\/\//)
    .required(),
  MONGO_REQUIRE_REPLICA_SET: Joi.boolean().truthy('true').falsy('false').default(true),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(5000),
  MONGO_MAX_POOL_SIZE: Joi.number().integer().min(1).max(500).default(20),
  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_USERNAME: Joi.string().allow('').default(''),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),
  REDIS_TLS: Joi.boolean().truthy('true').falsy('false').default(false),
  QUEUE_PREFIX: Joi.string().min(1).max(100).default('rich-culture'),
  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  RATE_LIMIT_STORAGE: Joi.string().valid('memory', 'redis').default('memory'),
  RATE_LIMIT_KEY_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9:_-]+$/)
    .min(1)
    .max(100)
    .default('rich-culture-rate-limit'),
  LOG_LEVEL: Joi.string()
    .valid('silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .default('info'),
  METRICS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  METRICS_BEARER_TOKEN: Joi.string().trim().min(32).max(500).allow('').default(''),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(900),
  JWT_REFRESH_TTL_SECONDS: Joi.number().integer().min(3600).max(31536000).default(2592000),
  AUTH_TOKEN_PEPPER: Joi.string().min(32).required(),
  CUSTOMER_JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  CUSTOMER_JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  CUSTOMER_TOKEN_PEPPER: Joi.string().min(32).required(),
  CUSTOMER_EMAIL_VERIFICATION_TTL_SECONDS: Joi.number()
    .integer()
    .min(300)
    .max(604800)
    .default(86400),
  CUSTOMER_PASSWORD_RESET_TTL_SECONDS: Joi.number().integer().min(300).max(3600).default(1800),
  CUSTOMER_AUTH_EMAIL_COOLDOWN_SECONDS: Joi.number().integer().min(30).max(3600).default(60),
  CUSTOMER_MOBILE_OTP_TTL_SECONDS: Joi.number().integer().min(300).max(900).default(600),
  CUSTOMER_MOBILE_OTP_COOLDOWN_SECONDS: Joi.number().integer().min(30).max(300).default(60),
  CUSTOMER_MOBILE_OTP_MAX_ATTEMPTS: Joi.number().integer().min(3).max(10).default(5),
  CUSTOMER_RETURN_WINDOW_DAYS: Joi.number().integer().min(1).max(30).default(7),
  EXCHANGE_RESERVATION_TTL_DAYS: Joi.number().integer().min(1).max(60).default(14),
  RETURN_EVIDENCE_MAX_FILES: Joi.number().integer().min(1).max(10).default(5),
  RETURN_EVIDENCE_MAX_UPLOAD_BYTES: Joi.number()
    .integer()
    .min(262_144)
    .max(10_485_760)
    .default(5_242_880),
  PUBLIC_STOREFRONT_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3000'),
  CSRF_SECRET: Joi.string().min(32).required(),
  CSRF_TTL_SECONDS: Joi.number().integer().min(300).max(86400).default(7200),
  COOKIE_SECURE: Joi.boolean().truthy('true').falsy('false').default(false),
  COOKIE_SAME_SITE: Joi.string().valid('strict', 'lax', 'none').default('strict'),
  COOKIE_DOMAIN: Joi.string().allow('').default(''),
  MEDIA_STORAGE_ROOT: Joi.string().min(1).max(1000).default('./data/media'),
  MEDIA_MAX_UPLOAD_BYTES: Joi.number().integer().min(1_048_576).max(26_214_400).default(26_214_400),
  MEDIA_MAX_INPUT_PIXELS: Joi.number()
    .integer()
    .min(1_000_000)
    .max(100_000_000)
    .default(40_000_000),
  MEDIA_WEBP_QUALITY: Joi.number().integer().min(60).max(95).default(82),
  MEDIA_STAGING_MAX_AGE_SECONDS: Joi.number().integer().min(300).max(86400).default(3600),
  MEDIA_MIN_FREE_BYTES: Joi.number()
    .integer()
    .min(67_108_864)
    .max(1_099_511_627_776)
    .default(536_870_912),
  RAZORPAY_KEY_ID: Joi.string().trim().min(8).max(100).required(),
  RAZORPAY_KEY_SECRET: Joi.string().min(16).max(200).required(),
  RAZORPAY_WEBHOOK_SECRET: Joi.string().min(16).max(200).required(),
  RAZORPAY_CHECKOUT_NAME: Joi.string().trim().min(1).max(120).default('Rich Culture'),
  RAZORPAY_API_TIMEOUT_MS: Joi.number().integer().min(1000).max(30000).default(10000),
  EMAIL_DELIVERY_MODE: Joi.string().valid('log', 'smtp').default('log'),
  EMAIL_FROM_NAME: Joi.string().trim().min(1).max(120).default('Rich Culture'),
  EMAIL_FROM_ADDRESS: Joi.string().trim().lowercase().email().default('no-reply@richculture.in'),
  OPERATIONS_ALERT_EMAILS: Joi.string().allow('').default(''),
  SMTP_HOST: Joi.string().trim().allow('').max(253).default(''),
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_SECURE: Joi.boolean().truthy('true').falsy('false').default(false),
  SMTP_REQUIRE_TLS: Joi.boolean().truthy('true').falsy('false').default(true),
  SMTP_USERNAME: Joi.string().allow('').max(254).default(''),
  SMTP_PASSWORD: Joi.string().allow('').max(1000).default(''),
  SMTP_CONNECTION_TIMEOUT_MS: Joi.number().integer().min(1000).max(60000).default(10000),
  SMTP_MAX_CONNECTIONS: Joi.number().integer().min(1).max(20).default(5),
  MESSAGE_DELIVERY_MODE: Joi.string().valid('log', 'http').default('log'),
  SMS_DELIVERY_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  WHATSAPP_DELIVERY_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  MESSAGE_PROVIDER_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .default(''),
  MESSAGE_PROVIDER_TOKEN: Joi.string().trim().min(16).max(1000).allow('').default(''),
  SMS_SENDER: Joi.string().trim().allow('').max(100).default(''),
  WHATSAPP_SENDER: Joi.string().trim().allow('').max(100).default(''),
  MESSAGE_PROVIDER_TIMEOUT_MS: Joi.number().integer().min(1000).max(30000).default(10000),
}).unknown(true);

export function validateEnvironment(
  input: Record<string, unknown>,
): EnvironmentVariables & Record<string, unknown> {
  const result: Joi.ValidationResult<EnvironmentVariables> = environmentSchema.validate(input, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });

  if (result.error) {
    throw new Error(`Environment validation failed: ${result.error.message}`);
  }

  const environment = result.value;
  if (environment.JWT_ACCESS_SECRET === environment.JWT_REFRESH_SECRET) {
    throw new Error('Environment validation failed: access and refresh JWT secrets must differ');
  }
  if (environment.CUSTOMER_JWT_ACCESS_SECRET === environment.CUSTOMER_JWT_REFRESH_SECRET) {
    throw new Error(
      'Environment validation failed: customer access and refresh JWT secrets must differ',
    );
  }
  if (environment.RAZORPAY_KEY_SECRET === environment.RAZORPAY_WEBHOOK_SECRET) {
    throw new Error('Environment validation failed: Razorpay API and webhook secrets must differ');
  }
  if (
    [environment.JWT_ACCESS_SECRET, environment.JWT_REFRESH_SECRET].includes(
      environment.CUSTOMER_JWT_ACCESS_SECRET,
    ) ||
    [environment.JWT_ACCESS_SECRET, environment.JWT_REFRESH_SECRET].includes(
      environment.CUSTOMER_JWT_REFRESH_SECRET,
    )
  ) {
    throw new Error('Environment validation failed: admin and customer JWT secrets must differ');
  }

  if (environment.COOKIE_SAME_SITE === 'none' && !environment.COOKIE_SECURE) {
    throw new Error('Environment validation failed: SameSite=None requires secure cookies');
  }
  if (environment.METRICS_ENABLED && !environment.METRICS_BEARER_TOKEN) {
    throw new Error(
      'Environment validation failed: metrics bearer token is required when metrics are enabled',
    );
  }

  const operationsEmails = environment.OPERATIONS_ALERT_EMAILS.split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  const invalidOperationsEmail = operationsEmails.find(
    (email) => Joi.string().email().validate(email).error,
  );
  if (invalidOperationsEmail) {
    throw new Error('Environment validation failed: operations alert emails must be valid');
  }
  if (Boolean(environment.SMTP_USERNAME) !== Boolean(environment.SMTP_PASSWORD)) {
    throw new Error(
      'Environment validation failed: SMTP username and password must either both be set or both be empty',
    );
  }
  if (environment.EMAIL_DELIVERY_MODE === 'smtp' && !environment.SMTP_HOST) {
    throw new Error('Environment validation failed: SMTP host is required in smtp delivery mode');
  }
  const mobileDeliveryEnabled =
    environment.SMS_DELIVERY_ENABLED || environment.WHATSAPP_DELIVERY_ENABLED;
  if (environment.MESSAGE_DELIVERY_MODE === 'http' && mobileDeliveryEnabled) {
    if (!environment.MESSAGE_PROVIDER_URL || !environment.MESSAGE_PROVIDER_TOKEN) {
      throw new Error(
        'Environment validation failed: message provider URL and token are required in http delivery mode',
      );
    }
    if (environment.SMS_DELIVERY_ENABLED && !environment.SMS_SENDER) {
      throw new Error('Environment validation failed: SMS sender is required when SMS is enabled');
    }
    if (environment.WHATSAPP_DELIVERY_ENABLED && !environment.WHATSAPP_SENDER) {
      throw new Error(
        'Environment validation failed: WhatsApp sender is required when WhatsApp is enabled',
      );
    }
    const providerUrl = new URL(environment.MESSAGE_PROVIDER_URL);
    if (providerUrl.username || providerUrl.password) {
      throw new Error(
        'Environment validation failed: message provider URL must not contain credentials',
      );
    }
  }

  if (environment.NODE_ENV === 'production') {
    const productionSecrets = [
      environment.JWT_ACCESS_SECRET,
      environment.JWT_REFRESH_SECRET,
      environment.AUTH_TOKEN_PEPPER,
      environment.CUSTOMER_JWT_ACCESS_SECRET,
      environment.CUSTOMER_JWT_REFRESH_SECRET,
      environment.CUSTOMER_TOKEN_PEPPER,
      environment.CSRF_SECRET,
      environment.RAZORPAY_KEY_SECRET,
      environment.RAZORPAY_WEBHOOK_SECRET,
      environment.MESSAGE_PROVIDER_TOKEN,
    ];
    if (
      productionSecrets.some(
        (secret) => secret.startsWith('dev-only-') || secret.startsWith('replace-with-'),
      )
    ) {
      throw new Error(
        'Environment validation failed: development or placeholder secrets cannot be used in production',
      );
    }
    if (!environment.COOKIE_SECURE) {
      throw new Error('Environment validation failed: production requires secure cookies');
    }
    if (!environment.MEDIA_STORAGE_ROOT.startsWith('/')) {
      throw new Error(
        'Environment validation failed: production media storage path must be absolute',
      );
    }
    if (environment.EMAIL_DELIVERY_MODE !== 'smtp') {
      throw new Error('Environment validation failed: production requires smtp email delivery');
    }
    if (mobileDeliveryEnabled && environment.MESSAGE_DELIVERY_MODE !== 'http') {
      throw new Error(
        'Environment validation failed: production mobile messaging requires http delivery',
      );
    }
    if (
      mobileDeliveryEnabled &&
      !environment.MESSAGE_PROVIDER_URL.toLowerCase().startsWith('https://')
    ) {
      throw new Error(
        'Environment validation failed: production message provider URL must use HTTPS',
      );
    }
    if (!environment.PUBLIC_STOREFRONT_URL.startsWith('https://')) {
      throw new Error('Environment validation failed: production storefront URL must use HTTPS');
    }
    if (!environment.METRICS_ENABLED) {
      throw new Error('Environment validation failed: production requires metrics to be enabled');
    }
    if (environment.APP_RELEASE === 'local') {
      throw new Error(
        'Environment validation failed: production requires an immutable application release identifier',
      );
    }
    if (operationsEmails.length === 0) {
      throw new Error(
        'Environment validation failed: production requires at least one operations alert email',
      );
    }
    if (environment.TRUST_PROXY_HOPS < 1) {
      throw new Error('Environment validation failed: production requires a trusted proxy hop');
    }
    if (environment.SWAGGER_ENABLED) {
      throw new Error('Environment validation failed: production Swagger must be disabled');
    }
    const corsOrigins = environment.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (!corsOrigins.length || corsOrigins.some((origin) => !isExactHttpsOrigin(origin))) {
      throw new Error(
        'Environment validation failed: production CORS origins must be exact HTTPS origins',
      );
    }
    if (environment.RATE_LIMIT_STORAGE !== 'redis') {
      throw new Error(
        'Environment validation failed: production requires Redis-backed rate limiting',
      );
    }
  }

  return environment;
}

function isExactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      value.replace(/\/$/, '') === url.origin
    );
  } catch {
    return false;
  }
}
