/** Central rate-limit tunables (HTTP throttler + WS gateway + Angie docs). */

export const RATE_LIMIT_WINDOW_MS = 60_000;

/** NestJS @nestjs/throttler named buckets (per user id, else per IP). */
export const HTTP_RATE_LIMITS = {
  auth: { name: 'auth' as const, ttl: RATE_LIMIT_WINDOW_MS, limit: 30 },
  write: { name: 'write' as const, ttl: RATE_LIMIT_WINDOW_MS, limit: 300 },
  read: { name: 'read' as const, ttl: RATE_LIMIT_WINDOW_MS, limit: 600 },
};

/** WebSocket gateway (in-memory, per replica). */
export const WS_RATE_LIMITS = {
  /** Upgrades accepted per client IP per window. */
  upgradePerIp: { limit: 30, windowMs: RATE_LIMIT_WINDOW_MS },
  /** Incoming messages per open socket per window. */
  messagesPerConnection: { limit: 120, windowMs: RATE_LIMIT_WINDOW_MS },
};

/**
 * Angie proxy limits (documented here; configured in angie/angie.conf).
 * - api_global: 50 r/s, burst 100
 * - api_auth: 5 r/s, burst 20
 * - ws_conn: 50 concurrent connections per IP
 */
export const ANGIE_RATE_LIMITS = {
  globalRps: 50,
  globalBurst: 100,
  authRps: 5,
  authBurst: 20,
  wsConnPerIp: 50,
} as const;
