import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseBase64Key } from '@/database/crypto/db-crypto';
import { secretsStore } from './secrets.store';

// /run/secrets: Docker/K8s read-only mount convention; ./secrets: local dev mirror.
const SECRETS_DIRS = ['/run/secrets', join(process.cwd(), 'secrets')];

const ENCRYPTION_KEY_PATTERN = /^DB_ENCRYPTION_KEY_V(\d+)$/;

const REQUIRED_SECRETS = ['JWT_SECRET', 'METRICS_TOKEN', 'DATABASE_URL'] as const;

/**
 * Resolve a secret: file mount wins over env (files rotate without redeploying env).
 * After reading from env, delete the key so it does not linger in process.env for
 * log dumps, /proc inspection, or accidental logging of the full environment.
 */
export function resolveOne(name: string): string | undefined {
  for (const dir of SECRETS_DIRS) {
    const filePath = join(dir, name);
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf8').trim();
    }
  }

  const fromEnv = process.env[name];
  if (fromEnv !== undefined) {
    delete process.env[name];
    return fromEnv;
  }

  return undefined;
}

/**
 * Discover all DB_ENCRYPTION_KEY_V<n> versions from env and secret files.
 * Multiple versions must be loaded during key rotation so old ciphertext still decrypts.
 */
export function discoverEncryptionKeyVersions(): number[] {
  const versions = new Set<number>();

  for (const key of Object.keys(process.env)) {
    const match = key.match(ENCRYPTION_KEY_PATTERN);
    if (match?.[1] != null) {
      versions.add(Number.parseInt(match[1], 10));
    }
  }

  for (const dir of SECRETS_DIRS) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const file of readdirSync(dir)) {
      const match = file.match(ENCRYPTION_KEY_PATTERN);
      if (match?.[1] != null) {
        versions.add(Number.parseInt(match[1], 10));
      }
    }
  }

  return [...versions].sort((a, b) => a - b);
}

function loadEncryptionKeys(): void {
  const versions = discoverEncryptionKeyVersions();
  if (versions.length === 0) {
    throw new Error('At least one DB_ENCRYPTION_KEY_V<n> is required');
  }

  for (const version of versions) {
    const name = `DB_ENCRYPTION_KEY_V${version}`;
    const value = resolveOne(name);
    if (!value) {
      throw new Error(`${name} is required`);
    }
    secretsStore.set(name, value);
  }
}

function loadStandardSecrets(): void {
  for (const name of REQUIRED_SECRETS) {
    const value = resolveOne(name);
    if (!value) {
      throw new Error(`${name} is required`);
    }
    secretsStore.set(name, value);
  }
}

export function loadRequiredSecretsSync(): void {
  loadEncryptionKeys();
  loadStandardSecrets();
}

export async function loadRequiredSecrets(): Promise<void> {
  loadRequiredSecretsSync();
}

export function getActiveEncryptionVersion(): number {
  const raw = process.env['DB_ENCRYPTION_KEY_ACTIVE'] ?? '1';
  const version = Number.parseInt(raw, 10);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('DB_ENCRYPTION_KEY_ACTIVE must be a positive integer');
  }
  return version;
}

export function buildDbCryptoConfig(): {
  keys: Map<number, Buffer>;
  activeVersion: number;
} {
  const activeVersion = getActiveEncryptionVersion();
  const keys = new Map<number, Buffer>();

  for (const name of secretsStore.listNames()) {
    const match = name.match(ENCRYPTION_KEY_PATTERN);
    if (!match?.[1]) {
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    const b64 = secretsStore.getRequired(name);
    keys.set(version, parseBase64Key(b64));
  }

  if (keys.size === 0) {
    throw new Error('At least one DB_ENCRYPTION_KEY_V<n> is required');
  }

  if (!keys.has(activeVersion)) {
    throw new Error(
      `DB_ENCRYPTION_KEY_ACTIVE=${activeVersion} but DB_ENCRYPTION_KEY_V${activeVersion} is not loaded`,
    );
  }

  return { keys, activeVersion };
}
