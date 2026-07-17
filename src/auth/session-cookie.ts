import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';

/** Cookies are scoped so `refresh` never lands anywhere except `/api/v1/auth/*`. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
const SESSION_ID_HEADER = 'x-session-id';
const SESSION_ID_RE = /^[a-z0-9_-]{1,32}$/;
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_REFRESH_TTL_SECONDS = 604_800;

/**
 * Extract and sanitise the `X-Session-Id` header. Two demo tabs share one origin, so this label
 * scopes the refresh cookie per logical client (e.g. `a`, `b`). Returns `default` when absent or
 * malformed.
 */
export function readSessionId(request: FastifyRequest): string {
  const raw = request.headers[SESSION_ID_HEADER];
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SESSION_ID;
  const value = Array.isArray(raw) ? raw[0] : String(raw);
  if (!value) return DEFAULT_SESSION_ID;
  const normalised = value.toLowerCase();
  return SESSION_ID_RE.test(normalised) ? normalised : DEFAULT_SESSION_ID;
}

export function refreshCookieName(sessionId: string): string {
  return `refresh_token_${sessionId}`;
}

/**
 * Persist a rotated refresh token as an HttpOnly cookie. The browser attaches it automatically on
 * subsequent `POST /api/v1/auth/refresh` calls (scoped by `Path`), so JavaScript never handles it.
 */
export function setRefreshCookie(
  reply: FastifyReply,
  sessionId: string,
  refreshToken: string,
  maxAgeSeconds: number = DEFAULT_REFRESH_TTL_SECONDS,
): void {
  reply.setCookie(refreshCookieName(sessionId), refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
  });
}

/** Remove the refresh cookie for the given session (used on auth failure to break stale-cookie loops). */
export function clearRefreshCookie(reply: FastifyReply, sessionId: string): void {
  reply.clearCookie(refreshCookieName(sessionId), {
    path: REFRESH_COOKIE_PATH,
  });
}

export function readRefreshCookie(request: FastifyRequest, sessionId: string): string | undefined {
  return request.cookies?.[refreshCookieName(sessionId)];
}
