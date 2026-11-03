import { describe, expect, it } from 'vitest';
import { JoinLimiter, TokenBucket } from './RateLimiter';

describe('TokenBucket', () => {
  it('超過突發量後拒絕，時間經過後補充', () => {
    const bucket = new TokenBucket(10, 3, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(150)).toBe(true);
  });
});

describe('JoinLimiter', () => {
  it('同一個 IP 在時間窗內的加入次數有上限', () => {
    const limiter = new JoinLimiter(2, 1000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 10)).toBe(true);
    expect(limiter.allow('a', 20)).toBe(false);
    expect(limiter.allow('b', 20)).toBe(true);
    expect(limiter.allow('a', 1500)).toBe(true);
  });
});
