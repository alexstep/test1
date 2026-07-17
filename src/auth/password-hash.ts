export async function hashPassword(prehash: string): Promise<string> {
  return Bun.password.hash(prehash, { algorithm: 'argon2id' });
}

export async function verifyPassword(
  hash: string,
  prehash: string,
): Promise<boolean> {
  return Bun.password.verify(prehash, hash);
}
