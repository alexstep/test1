export interface RateWindow {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter. Returns true if the call is allowed (and bumps the
 * counter); false if the key is over the limit for the current window.
 */
export function checkAndBumpCounter(
  map: Map<string, RateWindow>,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const existing = map.get(key);
  if (!existing || now >= existing.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= limit) {
    return false;
  }
  existing.count += 1;
  return true;
}

/** Drop expired windows (lazy GC for long-lived upgrade-per-IP map). */
export function pruneExpiredCounters(
  map: Map<string, RateWindow>,
  now: number = Date.now(),
): void {
  for (const [key, window] of map) {
    if (now >= window.resetAt) {
      map.delete(key);
    }
  }
}

/** First IP from X-Forwarded-For, else socket remoteAddress. */
export function clientIpFromUpgrade(
  headers: { [key: string]: string | string[] | undefined },
  remoteAddress: string | undefined,
): string {
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  if (Array.isArray(xff) && xff[0]) {
    const first = xff[0].split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? 'unknown';
}
