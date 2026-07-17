import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { APP_GUARD } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { SecretsModule } from './secrets/secrets.module';
import { SecretsService } from './secrets/secrets.service';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { GamesModule } from './games/games.module';
import { MatchesModule } from './matches/matches.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { MetricsModule } from './metrics/metrics.module';
import { RedisModule } from './redis/redis.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { UserOrIpThrottlerGuard } from './common/guards/user-or-ip.throttler.guard';
import { HTTP_RATE_LIMITS } from './common/rate-limits';
import { User } from './database/entities/user.entity';
import { RefreshToken } from './database/entities/refresh-token.entity';
import { Game } from './database/entities/game.entity';
import { Match } from './database/entities/match.entity';
import { migrations } from './database/migrations';

@Module({
  imports: [
    SecretsModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        name: HTTP_RATE_LIMITS.auth.name,
        ttl: HTTP_RATE_LIMITS.auth.ttl,
        limit: HTTP_RATE_LIMITS.auth.limit,
      },
      {
        name: HTTP_RATE_LIMITS.write.name,
        ttl: HTTP_RATE_LIMITS.write.ttl,
        limit: HTTP_RATE_LIMITS.write.limit,
      },
      {
        name: HTTP_RATE_LIMITS.read.name,
        ttl: HTTP_RATE_LIMITS.read.ttl,
        limit: HTTP_RATE_LIMITS.read.limit,
      },
    ]),
    LoggerModule.forRoot({
      pinoHttp: {
        // Opt-in only: bun build --minify can fold process.env.NODE_ENV at
        // compile time, which would otherwise bake pino-pretty into the bundle.
        transport:
          process.env['PINO_PRETTY'] === '1'
            ? { target: 'pino-pretty' }
            : undefined,
        autoLogging: true,
        genReqId: (req) => {
          const rid = req.headers['x-request-id'];
          return typeof rid === 'string' ? rid : randomUUID();
        },
        redact: ['req.headers.authorization'],
      },
    }),
    TypeOrmModule.forRootAsync({
      imports: [SecretsModule],
      inject: [SecretsService, ConfigService],
      useFactory: (secrets: SecretsService, config: ConfigService) => ({
        type: 'postgres',
        url: secrets.getRequired('DATABASE_URL'),
        entities: [User, RefreshToken, Game, Match],
        migrations,
        migrationsRun: true,
        synchronize: false,
        logging: config.get('NODE_ENV') !== 'production',
      }),
    }),
    RedisModule,
    HealthModule,
    AuthModule,
    GamesModule,
    MatchesModule,
    LeaderboardModule,
    MetricsModule,
  ],
  providers: [
    // JwtAuthGuard first so req.user is set before UserOrIpThrottlerGuard tracks by id.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: UserOrIpThrottlerGuard,
    },
  ],
})
export class AppModule {}
