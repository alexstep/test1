import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  createCipheriv,
  randomBytes,
} from 'crypto';
import {
  blindIndex,
  decryptEmail,
  decryptField,
  deriveKey,
  emailBlindIndex,
  encryptEmail,
  encryptField,
  initDbCrypto,
  normalizeEmail,
  resetDbCryptoForTests,
  EMAIL_BLIND_INDEX_PURPOSE,
  EMAIL_ENCRYPT_PURPOSE,
} from './db-crypto';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const TEST_KEY_V2 = Buffer.alloc(32, 9).toString('base64');

function initTestCrypto(activeVersion = 1): void {
  initDbCrypto({
    keys: new Map([
      [1, Buffer.alloc(32, 7)],
      [2, Buffer.alloc(32, 9)],
    ]),
    activeVersion,
  });
}

describe('db-crypto', () => {
  beforeAll(() => {
    initTestCrypto();
  });

  afterAll(() => {
    resetDbCryptoForTests();
  });

  describe('normalizeEmail', () => {
    it('trims and lowercases', () => {
      expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
    });
  });

  describe('deriveKey', () => {
    it('returns 32-byte buffers that differ by purpose', () => {
      const a = deriveKey(EMAIL_ENCRYPT_PURPOSE);
      const b = deriveKey(EMAIL_BLIND_INDEX_PURPOSE);
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
      expect(a.equals(b)).toBe(false);
    });

    it('is deterministic for the same purpose', () => {
      const a = deriveKey('email:encrypt');
      const b = deriveKey('email:encrypt');
      expect(a.equals(b)).toBe(true);
    });

    it('includes version in HKDF info', () => {
      const v1 = deriveKey('test:encrypt', 1);
      const v2 = deriveKey('test:encrypt', 2);
      expect(v1.equals(v2)).toBe(false);
    });
  });

  describe('encryptField / decryptField', () => {
    it('round-trips plaintext with version prefix', () => {
      const cipher = encryptField('secret-value', 'test:encrypt');
      expect(cipher.startsWith('v1:')).toBe(true);
      expect(decryptField(cipher, 'test:encrypt')).toBe('secret-value');
    });

    it('decrypts legacy v1 payloads without prefix', () => {
      resetDbCryptoForTests();
      initDbCrypto({
        keys: new Map([[1, Buffer.from(TEST_KEY, 'base64')]]),
        activeVersion: 1,
      });
      const legacyKey = deriveKey('test:encrypt', 1, true);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
      const encrypted = Buffer.concat([
        cipher.update('legacy', 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      const legacy = Buffer.concat([iv, tag, encrypted]).toString('base64');
      expect(decryptField(legacy, 'test:encrypt')).toBe('legacy');
      initTestCrypto();
    });

    it('produces different ciphertext on each encrypt (random IV)', () => {
      const a = encryptField('same', 'test:encrypt');
      const b = encryptField('same', 'test:encrypt');
      expect(a).not.toBe(b);
      expect(decryptField(a, 'test:encrypt')).toBe('same');
      expect(decryptField(b, 'test:encrypt')).toBe('same');
    });

    it('encrypts with active version and decrypts with stored version', () => {
      resetDbCryptoForTests();
      initDbCrypto({
        keys: new Map([
          [1, Buffer.from(TEST_KEY, 'base64')],
          [2, Buffer.from(TEST_KEY_V2, 'base64')],
        ]),
        activeVersion: 2,
      });
      const cipher = encryptField('rotated', 'test:encrypt');
      expect(cipher.startsWith('v2:')).toBe(true);
      expect(decryptField(cipher, 'test:encrypt')).toBe('rotated');
      initTestCrypto();
    });
  });

  describe('encryptEmail / decryptEmail', () => {
    it('normalizes before encrypt and round-trips', () => {
      const cipher = encryptEmail('  User@Example.com ');
      expect(decryptEmail(cipher)).toBe('user@example.com');
    });
  });

  describe('blindIndex / emailBlindIndex', () => {
    it('is deterministic for the same email', () => {
      expect(emailBlindIndex('a@b.com')).toBe(emailBlindIndex('a@b.com'));
      expect(emailBlindIndex('A@B.COM')).toBe(emailBlindIndex('a@b.com'));
    });

    it('differs for different emails', () => {
      expect(emailBlindIndex('a@b.com')).not.toBe(emailBlindIndex('c@d.com'));
    });

    it('uses purpose-specific HMAC keys', () => {
      const viaEmail = emailBlindIndex('a@b.com');
      const viaGeneric = blindIndex(
        normalizeEmail('a@b.com'),
        EMAIL_BLIND_INDEX_PURPOSE,
      );
      expect(viaEmail).toBe(viaGeneric);
      expect(viaEmail).toHaveLength(64);
    });

    it('always uses v1 key even when active version is v2', () => {
      resetDbCryptoForTests();
      initDbCrypto({
        keys: new Map([
          [1, Buffer.from(TEST_KEY, 'base64')],
          [2, Buffer.from(TEST_KEY_V2, 'base64')],
        ]),
        activeVersion: 2,
      });
      const indexAtV1 = emailBlindIndex('a@b.com');
      initDbCrypto({
        keys: new Map([[1, Buffer.from(TEST_KEY, 'base64')]]),
        activeVersion: 1,
      });
      const indexStillV1 = emailBlindIndex('a@b.com');
      expect(indexAtV1).toBe(indexStillV1);
      initTestCrypto();
    });
  });

  describe('initDbCrypto validation', () => {
    it('throws when not initialized', () => {
      resetDbCryptoForTests();
      expect(() => encryptEmail('a@b.com')).toThrow(/not initialized/);
      initTestCrypto();
    });

    it('throws when active version key is missing', () => {
      expect(() =>
        initDbCrypto({
          keys: new Map([[1, Buffer.alloc(32, 7)]]),
          activeVersion: 2,
        }),
      ).toThrow(/not configured/);
    });

    it('throws when key is wrong length', () => {
      expect(() =>
        initDbCrypto({
          keys: new Map([[1, Buffer.alloc(16)]]),
          activeVersion: 1,
        }),
      ).toThrow(/32 bytes/);
    });
  });
});
