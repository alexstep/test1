import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resetDbCryptoForTests } from '@/database/crypto/db-crypto';
import { secretsStore } from './secrets.store';
import {
  buildDbCryptoConfig,
  discoverEncryptionKeyVersions,
  loadRequiredSecretsSync,
  resolveOne,
} from './secrets.loader';

const TEST_KEY_V1 = Buffer.alloc(32, 7).toString('base64');
const TEST_KEY_V2 = Buffer.alloc(32, 9).toString('base64');

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of keys) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('secrets', () => {
  const envKeys = [
    'JWT_SECRET',
    'METRICS_TOKEN',
    'DATABASE_URL',
    'DB_ENCRYPTION_KEY_V1',
    'DB_ENCRYPTION_KEY_V2',
    'DB_ENCRYPTION_KEY_ACTIVE',
  ];

  afterEach(() => {
    secretsStore.clearForTests();
    resetDbCryptoForTests();
  });

  describe('resolveOne', () => {
    it('reads from env and scrubs the variable', () => {
      const snap = snapshotEnv(['JWT_SECRET']);
      process.env['JWT_SECRET'] = 'from-env';
      expect(resolveOne('JWT_SECRET')).toBe('from-env');
      expect(process.env['JWT_SECRET']).toBeUndefined();
      restoreEnv(snap);
    });

    it('prefers secret file over env', () => {
      const secretsDir = join(process.cwd(), 'secrets');
      const filePath = join(secretsDir, 'JWT_SECRET');
      const hadDir = existsSync(secretsDir);
      if (!hadDir) {
        mkdirSync(secretsDir, { recursive: true });
      }
      writeFileSync(filePath, 'from-file\n');
      const snap = snapshotEnv(['JWT_SECRET']);
      process.env['JWT_SECRET'] = 'from-env';

      expect(resolveOne('JWT_SECRET')).toBe('from-file');
      expect(process.env['JWT_SECRET']).toBe('from-env');

      rmSync(filePath, { force: true });
      if (!hadDir && existsSync(secretsDir)) {
        rmSync(secretsDir, { recursive: true, force: true });
      }
      restoreEnv(snap);
    });
  });

  describe('discoverEncryptionKeyVersions', () => {
    it('finds versioned keys in env', () => {
      const snap = snapshotEnv(['DB_ENCRYPTION_KEY_V1', 'DB_ENCRYPTION_KEY_V2']);
      process.env['DB_ENCRYPTION_KEY_V1'] = TEST_KEY_V1;
      process.env['DB_ENCRYPTION_KEY_V2'] = TEST_KEY_V2;
      expect(discoverEncryptionKeyVersions()).toEqual([1, 2]);
      restoreEnv(snap);
    });
  });

  describe('loadRequiredSecretsSync', () => {
    it('loads required secrets and scrubs env', () => {
      const snap = snapshotEnv(envKeys);
      process.env['JWT_SECRET'] = 'jwt';
      process.env['METRICS_TOKEN'] = 'metrics';
      process.env['DATABASE_URL'] = 'postgres://localhost/db';
      process.env['DB_ENCRYPTION_KEY_V1'] = TEST_KEY_V1;

      loadRequiredSecretsSync();

      expect(secretsStore.getRequired('JWT_SECRET')).toBe('jwt');
      expect(secretsStore.getRequired('METRICS_TOKEN')).toBe('metrics');
      expect(secretsStore.getRequired('DATABASE_URL')).toBe(
        'postgres://localhost/db',
      );
      expect(secretsStore.getRequired('DB_ENCRYPTION_KEY_V1')).toBe(TEST_KEY_V1);
      expect(process.env['JWT_SECRET']).toBeUndefined();
      expect(process.env['METRICS_TOKEN']).toBeUndefined();
      expect(process.env['DATABASE_URL']).toBeUndefined();
      expect(process.env['DB_ENCRYPTION_KEY_V1']).toBeUndefined();

      restoreEnv(snap);
    });

    it('throws when a required secret is missing', () => {
      const snap = snapshotEnv(envKeys);
      process.env['DB_ENCRYPTION_KEY_V1'] = TEST_KEY_V1;
      delete process.env['JWT_SECRET'];
      delete process.env['METRICS_TOKEN'];
      delete process.env['DATABASE_URL'];

      expect(() => loadRequiredSecretsSync()).toThrow(/JWT_SECRET/);

      restoreEnv(snap);
    });
  });

  describe('buildDbCryptoConfig', () => {
    it('builds versioned key map from loaded secrets', () => {
      const snap = snapshotEnv(envKeys);
      process.env['JWT_SECRET'] = 'jwt';
      process.env['METRICS_TOKEN'] = 'metrics';
      process.env['DATABASE_URL'] = 'postgres://localhost/db';
      process.env['DB_ENCRYPTION_KEY_V1'] = TEST_KEY_V1;
      process.env['DB_ENCRYPTION_KEY_V2'] = TEST_KEY_V2;
      process.env['DB_ENCRYPTION_KEY_ACTIVE'] = '2';

      loadRequiredSecretsSync();
      const config = buildDbCryptoConfig();

      expect(config.activeVersion).toBe(2);
      expect(config.keys.get(1)?.equals(Buffer.from(TEST_KEY_V1, 'base64'))).toBe(
        true,
      );
      expect(config.keys.get(2)?.equals(Buffer.from(TEST_KEY_V2, 'base64'))).toBe(
        true,
      );

      restoreEnv(snap);
    });
  });
});

describe('SecretsService', () => {
  beforeEach(() => {
    secretsStore.clearForTests();
    secretsStore.set('JWT_SECRET', 'test-jwt');
  });

  afterEach(() => {
    secretsStore.clearForTests();
  });

  it('delegates to secretsStore', async () => {
    const { SecretsService } = await import('./secrets.service');
    const service = new SecretsService();
    expect(service.getRequired('JWT_SECRET')).toBe('test-jwt');
    expect(service.has('JWT_SECRET')).toBe(true);
    expect(service.get('MISSING')).toBeUndefined();
  });
});
