import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SecretsModule } from '@/secrets/secrets.module';
import { SecretsService } from '@/secrets/secrets.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { User } from '@/database/entities/user.entity';
import { RefreshToken } from '@/database/entities/refresh-token.entity';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [SecretsModule, ConfigModule],
      inject: [SecretsService, ConfigService],
      // Signing secret from SecretsService (scrubbed from env); TTL from ConfigService (non-secret).
      useFactory: (secrets: SecretsService, config: ConfigService) => ({
        secret: secrets.getRequired('JWT_SECRET'),
        signOptions: {
          expiresIn: Number(config.get<number>('JWT_ACCESS_TTL') || 900),
        },
      }),
    }),
    TypeOrmModule.forFeature([User, RefreshToken]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
