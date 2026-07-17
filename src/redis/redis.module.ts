import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClient } from 'bun';

export const REDIS_DATA = 'REDIS_DATA';
export const REDIS_PUBLISHER = 'REDIS_PUBLISHER';
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';

export type { RedisClient };

function createRedisFactory(token: string) {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: async (config: ConfigService): Promise<RedisClient> => {
      const url = config.get<string>('REDIS_URL') || 'redis://localhost:6379';
      const client = new RedisClient(url, {
        autoReconnect: true,
        maxRetries: 20,
        enableOfflineQueue: true,
      });
      await client.connect();
      return client;
    },
  };
}

@Global()
@Module({
  providers: [
    createRedisFactory(REDIS_DATA),
    createRedisFactory(REDIS_PUBLISHER),
    createRedisFactory(REDIS_SUBSCRIBER),
  ],
  exports: [REDIS_DATA, REDIS_PUBLISHER, REDIS_SUBSCRIBER],
})
export class RedisModule {}
