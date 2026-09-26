import { RedisScriptExecutor, RedisThrottlerStorage } from './redis-throttler.storage';

describe('RedisThrottlerStorage', () => {
  it('uses a bounded namespaced key and maps the atomic Redis result', async () => {
    const evaluateScript = jest.fn<Promise<unknown>, [string, string[], string[]]>(() =>
      Promise.resolve([6, 42, 1, 30]),
    );
    const executor: RedisScriptExecutor = { evaluateScript };
    const storage = new RedisThrottlerStorage(executor, 'rich-culture-test-rate-limit');

    await expect(
      storage.increment('hashed-route-and-ip', 60_000, 5, 30_000, 'default'),
    ).resolves.toEqual({
      totalHits: 6,
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
    expect(evaluateScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('TIME')"),
      ['rich-culture-test-rate-limit:default:hashed-route-and-ip'],
      ['60000', '5', '30000'],
    );
  });

  it('rejects malformed Redis responses', async () => {
    const executor: RedisScriptExecutor = {
      evaluateScript: () => Promise.resolve(['unexpected']),
    };
    const storage = new RedisThrottlerStorage(executor, 'rich-culture-test-rate-limit');

    await expect(storage.increment('key', 1000, 1, 1000, 'default')).rejects.toThrow(
      'invalid rate-limit result',
    );
  });
});
