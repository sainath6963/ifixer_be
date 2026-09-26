import {
  decryptCustomerActionToken,
  encryptCustomerActionToken,
} from './customer-action-token-envelope';

describe('customer action token envelope', () => {
  const secret = 'test-customer-token-pepper-32-characters-minimum';
  const rawToken = 'secure_customer_action_token_1234567890abcdef';

  it('round-trips without persisting the raw token', () => {
    const envelope = encryptCustomerActionToken(rawToken, secret);

    expect(envelope).not.toContain(rawToken);
    expect(decryptCustomerActionToken(envelope, secret)).toBe(rawToken);
  });

  it('rejects tampered envelopes and a different key', () => {
    const envelope = encryptCustomerActionToken(rawToken, secret);
    const tampered = `${envelope.slice(0, -1)}${envelope.endsWith('a') ? 'b' : 'a'}`;

    expect(decryptCustomerActionToken(tampered, secret)).toBeUndefined();
    expect(
      decryptCustomerActionToken(envelope, 'different-customer-token-pepper-32-characters'),
    ).toBeUndefined();
  });
});
