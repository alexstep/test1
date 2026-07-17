import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'crypto';
import type { ValueTransformer } from 'typeorm';

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HKDF_SALT = Buffer.from('leaderboard-db-encryption');
const VERSION_PREFIX = /^v(\d+):(.+)$/s;

export const EMAIL_ENCRYPT_PURPOSE = 'email:encrypt';
export const EMAIL_BLIND_INDEX_PURPOSE = 'email:blind-index';

const BLIND_INDEX_VERSION = 1;

// Field-level PII encryption at rest. AES-256-GCM authenticates ciphertext; a fresh
// random IV per write stops equal emails from producing equal ciphertext in the DB.

let keyVersions = new Map<number, Buffer>();
let activeVersion = 1;

export interface DbCryptoConfig {
  keys: Map<number, Buffer>;
  activeVersion: number;
}

export function parseBase64Key(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error('DB encryption key must decode to exactly 32 bytes (base64)');
  }
  return key;
}

export function initDbCrypto(config: DbCryptoConfig): void {
  if (config.keys.size === 0) {
    throw new Error('At least one DB encryption key version is required');
  }
  for (const [version, key] of config.keys) {
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `DB encryption key version ${version} must be exactly 32 bytes`,
      );
    }
  }
  if (!config.keys.has(config.activeVersion)) {
    throw new Error(
      `Active encryption version ${config.activeVersion} is not configured`,
    );
  }
  keyVersions = new Map(config.keys);
  activeVersion = config.activeVersion;
}

/** @internal test helper */
export function resetDbCryptoForTests(): void {
  keyVersions = new Map();
  activeVersion = 1;
}

function requireInitialized(): void {
  if (keyVersions.size === 0) {
    throw new Error('db-crypto is not initialized; call initDbCrypto first');
  }
}

function getMasterKey(version: number): Buffer {
  requireInitialized();
  const key = keyVersions.get(version);
  if (!key) {
    throw new Error(`DB encryption key version ${version} is not configured`);
  }
  return key;
}

/**
 * HKDF derives isolated sub-keys per purpose (encrypt vs blind-index) so material
 * for one operation cannot be replayed for the other. Info string includes version
 * for forward-compatible rotation without cross-purpose key reuse.
 */
export function deriveKey(
  purpose: string,
  version = activeVersion,
  legacyInfo = false,
): Buffer {
  const info = legacyInfo ? purpose : `${purpose}:v${version}`;
  return Buffer.from(
    hkdfSync('sha256', getMasterKey(version), HKDF_SALT, info, KEY_LENGTH),
  );
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseCiphertext(payload: string): { version: number; data: string } {
  const match = payload.match(VERSION_PREFIX);
  if (match?.[1] != null && match[2] != null) {
    return {
      version: Number.parseInt(match[1], 10),
      data: match[2],
    };
  }
  return { version: 1, data: payload };
}

/**
 * Encrypt with AES-256-GCM. v<N> prefix records which master key was used so
 * decrypt can pick the right key during rotation without re-encrypting all rows.
 * Storage format: v<N>:base64(iv || authTag || ciphertext).
 */
export function encryptField(plaintext: string, purpose: string): string {
  const version = activeVersion;
  const key = deriveKey(purpose, version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString('base64');
  return `v${version}:${payload}`;
}

// Decrypt with the key version from the v<N> prefix (legacy rows without prefix use v1).
export function decryptField(payload: string, purpose: string): string {
  const isLegacyFormat = !VERSION_PREFIX.test(payload);
  const { version, data } = parseCiphertext(payload);
  const key = deriveKey(
    purpose,
    version,
    isLegacyFormat && version === BLIND_INDEX_VERSION,
  );
  const buf = Buffer.from(data, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Invalid encrypted field payload');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Searchable fingerprint - HMAC, not AES. Ciphertext is randomized per write, so
 * equality queries cannot scan the encrypted email column. Locked to v1 + legacy
 * HKDF info so rotating encryption keys does not invalidate existing indexes.
 */
export function blindIndex(value: string, purpose: string): string {
  return createHmac(
    'sha256',
    deriveKey(purpose, BLIND_INDEX_VERSION, true),
  )
    .update(value)
    .digest('hex');
}

export function encryptEmail(email: string): string {
  return encryptField(normalizeEmail(email), EMAIL_ENCRYPT_PURPOSE);
}

export function decryptEmail(payload: string): string {
  return decryptField(payload, EMAIL_ENCRYPT_PURPOSE);
}

export function emailBlindIndex(email: string): string {
  return blindIndex(normalizeEmail(email), EMAIL_BLIND_INDEX_PURPOSE);
}

/**
 * TypeORM transformer: services/repos work with plaintext email; only the DB
 * column stores ciphertext. Keeps encryption policy in one place, not scattered
 * across auth and user persistence code.
 */
export const EncryptedEmailTransformer: ValueTransformer = {
  to(value: string | null | undefined): string | null | undefined {
    if (value == null || value === '') {
      return value;
    }
    return encryptEmail(value);
  },
  from(value: string | null | undefined): string | null | undefined {
    if (value == null || value === '') {
      return value;
    }
    return decryptEmail(value);
  },
};
