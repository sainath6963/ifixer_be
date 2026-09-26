import type { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export interface RedisScriptExecutor {
  evaluateScript(script: string, keys: string[], arguments_: string[]): Promise<unknown>;
}

const INCREMENT_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local windowStarted = tonumber(redis.call('HGET', KEYS[1], 'windowStarted') or now)
local totalHits = tonumber(redis.call('HGET', KEYS[1], 'totalHits') or 0)
local blockedUntil = tonumber(redis.call('HGET', KEYS[1], 'blockedUntil') or 0)

if blockedUntil > now then
  local timeToExpire = math.max(0, math.ceil((windowStarted + ttl - now) / 1000))
  local timeToBlockExpire = math.max(1, math.ceil((blockedUntil - now) / 1000))
  return { totalHits, timeToExpire, 1, timeToBlockExpire }
end

if blockedUntil > 0 or now - windowStarted >= ttl then
  windowStarted = now
  totalHits = 0
  blockedUntil = 0
end

totalHits = totalHits + 1
if totalHits > limit then
  blockedUntil = now + blockDuration
end

redis.call(
  'HSET',
  KEYS[1],
  'windowStarted', windowStarted,
  'totalHits', totalHits,
  'blockedUntil', blockedUntil
)
local expiresAt = math.max(windowStarted + ttl, blockedUntil)
redis.call('PEXPIRE', KEYS[1], math.max(1, expiresAt - now))

local timeToExpire = math.max(1, math.ceil((windowStarted + ttl - now) / 1000))
local isBlocked = 0
local timeToBlockExpire = 0
if blockedUntil > now then
  isBlocked = 1
  timeToBlockExpire = math.max(1, math.ceil((blockedUntil - now) / 1000))
end
return { totalHits, timeToExpire, isBlocked, timeToBlockExpire }
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    private readonly redis: RedisScriptExecutor,
    private readonly prefix: string,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const raw = await this.redis.evaluateScript(
      INCREMENT_SCRIPT,
      [`${this.prefix}:${throttlerName}:${key}`],
      [String(ttl), String(limit), String(blockDuration)],
    );
    if (!this.isStorageResult(raw)) {
      throw new Error('Redis returned an invalid rate-limit result');
    }
    return {
      totalHits: raw[0],
      timeToExpire: raw[1],
      isBlocked: raw[2] === 1,
      timeToBlockExpire: raw[3],
    };
  }

  private isStorageResult(value: unknown): value is [number, number, number, number] {
    return (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
    );
  }
}
