import { decryptCustomerMobileOtp, encryptCustomerMobileOtp } from './customer-otp-envelope';

describe('customer mobile OTP envelope', () => {
  const secret = 'test-customer-token-pepper-32-characters-minimum';

  it('round-trips a six-digit OTP without persisting plaintext', () => {
    const envelope = encryptCustomerMobileOtp('482913', secret);

    expect(envelope).not.toContain('482913');
    expect(decryptCustomerMobileOtp(envelope, secret)).toBe('482913');
  });

  it('rejects tampered envelopes and a different encryption secret', () => {
    const envelope = encryptCustomerMobileOtp('482913', secret);
    const parts = envelope.split('.');
    parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1) ?? ''}`;

    expect(decryptCustomerMobileOtp(parts.join('.'), secret)).toBeUndefined();
    expect(decryptCustomerMobileOtp(envelope, `${secret}-different`)).toBeUndefined();
  });
});
