import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { initDbCrypto } from '@/database/crypto/db-crypto';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
initDbCrypto({
  keys: new Map([[1, Buffer.from(TEST_KEY, 'base64')]]),
  activeVersion: 1,
});

const mockedHashPassword = mock(() =>
  Promise.resolve('$argon2id$hashed'),
);
const mockedVerifyPassword = mock();

void mock.module('./password-hash', () => ({
  hashPassword: mockedHashPassword,
  verifyPassword: mockedVerifyPassword,
}));

import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { User } from '@/database/entities/user.entity';
import { RefreshToken } from '@/database/entities/refresh-token.entity';
import { hashPasswordPrehash } from './password-prehash';
import { emailBlindIndex } from '@/database/crypto/db-crypto';

const TEST_EMAIL = 'a@b.com';
const TEST_PASSWORD_PREHASH = hashPasswordPrehash('password123', TEST_EMAIL);
const WRONG_PASSWORD_PREHASH = hashPasswordPrehash('wrongpassword', TEST_EMAIL);
const TEST_EMAIL_BLIND_INDEX = emailBlindIndex(TEST_EMAIL);

type MockFn = ReturnType<typeof mock>;

interface MockRepo {
  findOne: MockFn;
  findOneOrFail: MockFn;
  create: MockFn;
  save: MockFn;
}

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: MockRepo;
  let refreshRepo: MockRepo;

  beforeEach(async () => {
    userRepo = {
      findOne: mock(),
      findOneOrFail: mock(),
      create: mock((data: Record<string, unknown>) => ({
        id: 'user-uuid',
        createdAt: new Date('2026-01-01'),
        ...data,
      })),
      save: mock((entity: unknown) => Promise.resolve(entity)),
    };

    refreshRepo = {
      findOne: mock(),
      findOneOrFail: mock(),
      create: mock((data: unknown) => data),
      save: mock((entity: unknown) => Promise.resolve(entity)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: { sign: mock(() => 'jwt-token') },
        },
        {
          provide: ConfigService,
          useValue: {
            get: mock((key: string) => {
              const map: Record<string, unknown> = {
                JWT_ACCESS_TTL: 900,
                JWT_REFRESH_TTL: 604800,
              };
              return map[key];
            }),
          },
        },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshRepo },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    mockedVerifyPassword.mockReset();
  });

  describe('signup', () => {
    it('creates a new user and returns formatted response', async () => {
      userRepo.findOne.mockResolvedValue(null);
      const result = await service.signup({
        email: TEST_EMAIL,
        password: TEST_PASSWORD_PREHASH,
      });
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { emailBlindIndex: TEST_EMAIL_BLIND_INDEX },
      });
      expect(result).toHaveProperty('id', 'user-uuid');
      expect(result).toHaveProperty('email', TEST_EMAIL);
      expect(result).toHaveProperty('created_at');
      expect(mockedHashPassword).toHaveBeenCalledWith(TEST_PASSWORD_PREHASH);
    });

    it('throws ConflictException for duplicate email', async () => {
      userRepo.findOne.mockResolvedValue({ id: 'existing' });
      await expect(
        service.signup({ email: TEST_EMAIL, password: TEST_PASSWORD_PREHASH }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('returns token pair for valid credentials', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'user-uuid',
        email: TEST_EMAIL,
        passwordHash: '$argon2id$hashed',
      });
      mockedVerifyPassword.mockResolvedValue(true);

      const result = await service.login({
        email: TEST_EMAIL,
        password: TEST_PASSWORD_PREHASH,
      });
      expect(userRepo.findOne).toHaveBeenCalledWith({
        where: { emailBlindIndex: TEST_EMAIL_BLIND_INDEX },
      });
      expect(result).toHaveProperty('access_token', 'jwt-token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('expires_in', 900);
      expect(mockedVerifyPassword).toHaveBeenCalledWith(
        '$argon2id$hashed',
        TEST_PASSWORD_PREHASH,
      );
    });

    it('throws UnauthorizedException for non-existent user', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(
        service.login({ email: 'no@user.com', password: TEST_PASSWORD_PREHASH }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for wrong password', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'user-uuid',
        email: TEST_EMAIL,
        passwordHash: '$argon2id$hashed',
      });
      mockedVerifyPassword.mockResolvedValue(false);
      await expect(
        service.login({ email: TEST_EMAIL, password: WRONG_PASSWORD_PREHASH }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    it('rotates tokens successfully', async () => {
      refreshRepo.findOne.mockResolvedValue({
        userId: 'user-uuid',
        tokenHash: 'hash',
        revoked: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      userRepo.findOneOrFail.mockResolvedValue({
        id: 'user-uuid',
        email: 'a@b.com',
      });

      const result = await service.refresh('some-refresh-token');
      expect(result).toHaveProperty('access_token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('expires_in', 900);
    });

    it('throws for invalid refresh token', async () => {
      refreshRepo.findOne.mockResolvedValue(null);
      await expect(service.refresh('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws for expired refresh token', async () => {
      refreshRepo.findOne.mockResolvedValue({
        userId: 'user-uuid',
        tokenHash: 'hash',
        revoked: false,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.refresh('expired-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
