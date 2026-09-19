import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { clientIp, RateLimiter } from '../rate-limit.js';

describe('RateLimiter', () => {
  it('allows exactly `limit` requests inside the window and rejects the next', () => {
    const limiter = new RateLimiter(3, 60_000);
    const now = 1_000_000;

    expect(limiter.check('a', now).allowed).toBe(true);
    expect(limiter.check('a', now + 10).allowed).toBe(true);
    expect(limiter.check('a', now + 20).allowed).toBe(true);
    expect(limiter.check('a', now + 30).allowed).toBe(false);
  });

  it('reports the seconds until the oldest hit leaves the window', () => {
    const limiter = new RateLimiter(1, 60_000);
    const now = 1_000_000;

    limiter.check('a', now);
    expect(limiter.check('a', now + 20_000).retryAfterSeconds).toBe(40);
    // Never advertises 0s: a client told to retry immediately would just bounce again.
    expect(limiter.check('a', now + 59_900).retryAfterSeconds).toBe(1);
  });

  it('slides: a hit that aged out of the window frees its slot', () => {
    const limiter = new RateLimiter(2, 60_000);
    const now = 1_000_000;

    limiter.check('a', now);
    limiter.check('a', now + 30_000);
    expect(limiter.check('a', now + 40_000).allowed).toBe(false);
    // The first hit is now older than the window; the second still counts.
    expect(limiter.check('a', now + 60_001).allowed).toBe(true);
    expect(limiter.check('a', now + 60_002).allowed).toBe(false);
  });

  it('does not charge a rejected request against the window', () => {
    const limiter = new RateLimiter(1, 60_000);
    const now = 1_000_000;

    limiter.check('a', now);
    limiter.check('a', now + 1_000); // rejected, must not push the window forward
    expect(limiter.check('a', now + 60_001).allowed).toBe(true);
  });

  it('keeps windows per key', () => {
    const limiter = new RateLimiter(1, 60_000);
    const now = 1_000_000;

    expect(limiter.check('1.1.1.1', now).allowed).toBe(true);
    expect(limiter.check('1.1.1.1', now).allowed).toBe(false);
    expect(limiter.check('2.2.2.2', now).allowed).toBe(true);
  });
});

function fakeRequest(headers: IncomingMessage['headers'], remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('clientIp', () => {
  it('takes the last hop of X-Forwarded-For (the proxy-appended peer, not the spoofable client value)', () => {
    expect(clientIp(fakeRequest({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }, '10.0.0.2'))).toBe(
      '10.0.0.2',
    );
  });

  it('trims whitespace and handles a single-hop header', () => {
    expect(clientIp(fakeRequest({ 'x-forwarded-for': '  203.0.113.7  ' }))).toBe('203.0.113.7');
  });

  it('uses the first header entry when Node collected repeated headers into an array', () => {
    expect(clientIp(fakeRequest({ 'x-forwarded-for': ['203.0.113.7', '198.51.100.4'] }))).toBe('203.0.113.7');
  });

  it('falls back to the socket peer when no proxy header is present', () => {
    expect(clientIp(fakeRequest({}, '198.51.100.4'))).toBe('198.51.100.4');
  });

  it('falls back to the socket peer when the header is empty', () => {
    expect(clientIp(fakeRequest({ 'x-forwarded-for': '' }, '198.51.100.4'))).toBe('198.51.100.4');
  });

  it('returns a stable key when nothing identifies the caller', () => {
    expect(clientIp(fakeRequest({}))).toBe('unknown');
  });
});
