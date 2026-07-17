import { describe, expect, it } from 'bun:test';
import { parseAuthMessage } from './leaderboard.gateway';

describe('parseAuthMessage', () => {
  it('accepts valid auth message', () => {
    expect(parseAuthMessage(JSON.stringify({ type: 'auth', token: 'abc' }))).toEqual({
      type: 'auth',
      token: 'abc',
    });
  });

  it('accepts Buffer input', () => {
    expect(
      parseAuthMessage(Buffer.from(JSON.stringify({ type: 'auth', token: 'x' }))),
    ).toEqual({ type: 'auth', token: 'x' });
  });

  it('rejects empty token', () => {
    expect(parseAuthMessage(JSON.stringify({ type: 'auth', token: '' }))).toBeNull();
  });

  it('rejects non-auth type', () => {
    expect(parseAuthMessage(JSON.stringify({ type: 'pong' }))).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseAuthMessage('not-json')).toBeNull();
  });

  it('rejects missing token field', () => {
    expect(parseAuthMessage(JSON.stringify({ type: 'auth' }))).toBeNull();
  });
});
