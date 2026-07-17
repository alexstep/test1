import { DataSource } from 'typeorm';
import { initDbCrypto } from './crypto/db-crypto';
import { User } from './entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Game } from './entities/game.entity';
import { Match } from './entities/match.entity';
import { migrations } from './migrations';
import {
  buildDbCryptoConfig,
  loadRequiredSecretsSync,
} from '@/secrets/secrets.loader';
import { secretsStore } from '@/secrets/secrets.store';

// TypeORM CLI imports this file directly (no Nest bootstrap). Sync load mirrors
// main.ts so migrations see the same secrets and encryption keys as the app.
loadRequiredSecretsSync();
initDbCrypto(buildDbCryptoConfig());

export default new DataSource({
  type: 'postgres',
  url: secretsStore.getRequired('DATABASE_URL'),
  entities: [User, RefreshToken, Game, Match],
  migrations,
  synchronize: false,
});
