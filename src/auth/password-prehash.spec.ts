import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { hashPasswordPrehash } from './password-prehash';

describe('hashPasswordPrehash', () => {
  it('matches the known domain-separated vector', () => {
    expect(hashPasswordPrehash('securePass123', 'player@example.com')).toBe(
      'f75088e29caf97691ef9fb92d30c7a7ba0fbfdb7349e0f11361146860a62d750',
    );
  });

  it('normalizes email case and surrounding whitespace', () => {
    const a = hashPasswordPrehash('securePass123', 'player@example.com');
    const b = hashPasswordPrehash('securePass123', '  Player@Example.com  ');
    expect(a).toBe(b);
  });

  it('changes digest when email changes', () => {
    const a = hashPasswordPrehash('securePass123', 'player@example.com');
    const b = hashPasswordPrehash('securePass123', 'other@example.com');
    expect(a).not.toBe(b);
  });

  it('is not bare sha256(password)', () => {
    const bare = createHash('sha256')
      .update('securePass123', 'utf8')
      .digest('hex');
    expect(hashPasswordPrehash('securePass123', 'player@example.com')).not.toBe(
      bare,
    );
  });
});
