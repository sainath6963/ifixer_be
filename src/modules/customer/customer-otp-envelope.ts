import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const KEY_CONTEXT = 'rich-culture/customer-mobile-otp-envelope/v1';

function encryptionKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_CONTEXT).digest();
}

export function encryptCustomerMobileOtp(otp: string, secret: string): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), initializationVector);
  const ciphertext = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    initializationVector.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptCustomerMobileOtp(envelope: unknown, secret: string): string | undefined {
  if (typeof envelope !== 'string' || envelope.length > 500) return undefined;
  const [version, initializationVector, authenticationTag, ciphertext, extra] = envelope.split('.');
  if (
    version !== ENVELOPE_VERSION ||
    !initializationVector ||
    !authenticationTag ||
    !ciphertext ||
    extra
  ) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(initializationVector, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'));
    const otp = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return /^\d{6}$/.test(otp) ? otp : undefined;
  } catch {
    return undefined;
  }
}
