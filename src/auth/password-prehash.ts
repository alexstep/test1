import { createHash } from 'crypto';

/** Domain separation prefix - binds the prehash to this service. */
export const PASSWORD_PREHASH_DOMAIN = 'leaderboard-v1';

export const PASSWORD_PREHASH_REGEX = /^[a-f0-9]{64}$/;

export function normalizePasswordPrehash(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmailForPrehash(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Domain-separated client prehash: SHA-256("leaderboard-v1:" + email + ":" + password).
 * Wire format stays 64 lowercase hex; this is password-equivalent for this API.
 */
export function hashPasswordPrehash(plaintext: string, email: string): string {
  const material = `${PASSWORD_PREHASH_DOMAIN}:${normalizeEmailForPrehash(email)}:${plaintext}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}
