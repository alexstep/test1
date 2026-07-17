import { describe, expect, it } from 'bun:test';
import {
  checkAndBumpCounter,
  clientIpFromUpgrade,
  pruneExpiredCounters,
  type RateWindow,
} from './rate-limit.util';

describe('checkAndBumpCounter', () => {
  it('allows requests within the limit', () => {
    const map = new Map<string, RateWindow>();
    const now = 1_000_000;
    expect(checkAndBumpCounter(map, 'a', 3, 60_000, now)).toBe(true);
    expect(checkAndBumpCounter(map, 'a', 3, 60_000, now + 1)).toBe(true);
    expect(checkAndBumpCounter(map, 'a', 3, 60_000, now + 2)).toBe(true);
    expect(map.get('a')?.count).toBe(3);
  });

  it('rejects when limit is exceeded in the same window', () => {
    const map = new Map<string, RateWindow>();
    const now = 1_000_000;
    checkAndBumpCounter(map, 'a', 2, 60_000, now);
    checkAndBumpCounter(map, 'a', 2, 60_000, now);
    expect(checkAndBumpCounter(map, 'a', 2, 60_000, now)).toBe(false);
    expect(map.get('a')?.count).toBe(2);
  });

  it('resets the window after expiry', () => {
    const map = new Map<string, RateWindow>();
    const now = 1_000_000;
    const windowMs = 60_000;
    checkAndBumpCounter(map, 'a', 1, windowMs, now);
    expect(checkAndBumpCounter(map, 'a', 1, windowMs, now + 1)).toBe(false);
    expect(checkAndBumpCounter(map, 'a', 1, windowMs, now + windowMs)).toBe(true);
    expect(map.get('a')?.count).toBe(1);
  });

  it('tracks keys independently', () => {
    const map = new Map<string, RateWindow>();
    const now = 1_000_000;
    expect(checkAndBumpCounter(map, 'a', 1, 60_000, now)).toBe(true);
    expect(checkAndBumpCounter(map, 'b', 1, 60_000, now)).toBe(true);
    expect(checkAndBumpCounter(map, 'a', 1, 60_000, now)).toBe(false);
    expect(checkAndBumpCounter(map, 'b', 1, 60_000, now)).toBe(false);
  });
});

describe('pruneExpiredCounters', () => {
  it('removes only expired entries', () => {
    const map = new Map<string, RateWindow>([
      ['old', { count: 1, resetAt: 100 }],
      ['live', { count: 2, resetAt: 200 }],
    ]);
    pruneExpiredCounters(map, 150);
    expect(map.has('old')).toBe(false);
    expect(map.has('live')).toBe(true);
  });
});

describe('clientIpFromUpgrade', () => {
  it('prefers first X-Forwarded-For hop', () => {
    expect(
      clientIpFromUpgrade(
        { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
        '127.0.0.1',
      ),
    ).toBe('1.2.3.4');
  });

  it('falls back to remoteAddress', () => {
    expect(clientIpFromUpgrade({}, '9.9.9.9')).toBe('9.9.9.9');
  });

  it('returns unknown when nothing is available', () => {
    expect(clientIpFromUpgrade({}, undefined)).toBe('unknown');
  });
});
