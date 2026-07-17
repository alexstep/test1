import { InitialSchema1720000000000 } from './1720000000000-InitialSchema';
import { EncryptUserEmail1720000001000 } from './1720000001000-EncryptUserEmail';
import { MatchIdempotencyKey1720000001000 } from './1720000001000-MatchIdempotencyKey';

/** Explicit list so migrations are included in the bun production bundle. */
export const migrations = [
  InitialSchema1720000000000,
  EncryptUserEmail1720000001000,
  MatchIdempotencyKey1720000001000,
];
