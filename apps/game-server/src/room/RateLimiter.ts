/** 權杖桶限流：每秒補充 rate 個，最多累積 burst 個。 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

/** 每個 IP 在時間窗內的加入次數限制。 */
export class JoinLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(ip: string, now = Date.now()): boolean {
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.attempts.set(ip, list);
      return false;
    }
    list.push(now);
    this.attempts.set(ip, list);
    return true;
  }
}
