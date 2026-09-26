export const CUSTOMER_ACCESS_COOKIE = 'rc_customer_access';
export const CUSTOMER_REFRESH_COOKIE = 'rc_customer_refresh';
export const CUSTOMER_CSRF_COOKIE = 'rc_customer_csrf';
export const CUSTOMER_CART_COOKIE = 'rc_cart';
export const CUSTOMER_CSRF_HEADER = 'x-csrf-token';

export const CUSTOMER_JWT_ISSUER = 'rich-culture-api';
export const CUSTOMER_JWT_AUDIENCE = 'rich-culture-customer';

export const CUSTOMER_ACCESS_SECURITY = 'customerAccessCookie';
export const CUSTOMER_REFRESH_SECURITY = 'customerRefreshCookie';

export const CART_MAX_DISTINCT_ITEMS = 50;
export const CART_MAX_ITEM_QUANTITY = 10;
export const GUEST_CART_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CUSTOMER_CART_TTL_SECONDS = 365 * 24 * 60 * 60;
