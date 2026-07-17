import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { User } from '@/database/entities/user.entity';
import { RefreshToken } from '@/database/entities/refresh-token.entity';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { normalizePasswordPrehash } from './password-prehash';
import { hashPassword, verifyPassword } from './password-hash';
import { emailBlindIndex } from '@/database/crypto/db-crypto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(RefreshToken) private readonly refreshRepo: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async signup(dto: SignupDto) {
    // Lookup by blind index: encrypted email column cannot be filtered in SQL.
    const existing = await this.userRepo.findOne({
      where: { emailBlindIndex: emailBlindIndex(dto.email) },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // dto.password is the client domain-separated SHA-256 prehash; argon2id hashes it at rest.
    const prehash = normalizePasswordPrehash(dto.password);
    const passwordHash = await hashPassword(prehash);
    const user = this.userRepo.create({
      email: dto.email,
      passwordHash,
    });
    const saved = await this.userRepo.save(user);

    return {
      id: saved.id,
      email: saved.email,
      created_at: saved.createdAt.toISOString(),
    };
  }

  async login(dto: LoginDto) {
    // Same blind-index lookup as signup - never query the encrypted email column.
    const user = await this.userRepo.findOne({
      where: { emailBlindIndex: emailBlindIndex(dto.email) },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const prehash = normalizePasswordPrehash(dto.password);
    const valid = await verifyPassword(user.passwordHash, prehash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokenPair(user);
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.refreshRepo.findOne({
      where: { tokenHash, revoked: false },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    stored.revoked = true;
    await this.refreshRepo.save(stored);

    const user = await this.userRepo.findOneOrFail({ where: { id: stored.userId } });
    return this.issueTokenPair(user);
  }

  private async issueTokenPair(user: User) {
    const payload = { sub: user.id, email: user.email };
    const accessTtl = Number(this.configService.get<number>('JWT_ACCESS_TTL') || 900);
    const refreshTtl = Number(this.configService.get<number>('JWT_REFRESH_TTL') || 604800);

    const accessToken = this.jwtService.sign(payload, { expiresIn: accessTtl });
    const rawRefreshToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);

    const refreshEntity = this.refreshRepo.create({
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + refreshTtl * 1000),
    });
    await this.refreshRepo.save(refreshEntity);

    return {
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      expires_in: accessTtl,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
