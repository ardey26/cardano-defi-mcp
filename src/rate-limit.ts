/**
 * In-memory sliding-window rate limiting for the HTTP transport.
 *
 * One process, one map: this is a single free-tier instance, so there is nothing
 * to share state with. A restart resets every window, which is acceptable for a PoC.
 */

import type { IncomingMessage } from 'node:http';

/** Sweep stale keys once the map grows past this, so idle IPs cannot accumulate forever. */
const SWEEP_THRESHOLD = 1024;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the oldest hit in the window expires. 0 when allowed. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * Records a hit for `key` and reports whether it fits in the window's budget.
   * A rejected request is not recorded, so a client that keeps hammering does not
   * push its own window forward forever.
   */
  check(key: string, now: number = Date.now()): RateLimitVerdict {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    this.hits.set(key, recent);

    if (recent.length >= this.limit) {
      const retryAfterMs = recent[0] + this.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    recent.push(now);
    if (this.hits.size > SWEEP_THRESHOLD) this.sweep(cutoff);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}

/**
 * The address to rate-limit by: the LAST hop of X-Forwarded-For when a proxy set
 * one, else the socket peer.
 *
 * Last, not first: Render's router APPENDS the true peer address to whatever
 * X-Forwarded-For the client sent, so the first hop is client-controlled — a
 * caller could prepend a fresh fake address per request and mint unlimited
 * rate-limit buckets. The last hop is the one written by the proxy we trust.
 */
export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const last = header?.split(',').at(-1)?.trim();
  return last || req.socket.remoteAddress || 'unknown';
}
