import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from '@/common/decorators/public.decorator';
import { HTTP_RATE_LIMITS } from '@/common/rate-limits';
import {
  SignupUserResponse,
  TokenPairResponse,
  ErrorResponse,
} from '@/common/openapi/responses.dto';
import {
  readSessionId,
  readRefreshCookie,
  setRefreshCookie,
  clearRefreshCookie,
} from './session-cookie';

@ApiTags('auth')
@SkipThrottle({ write: true, read: true })
@Throttle({
  auth: {
    limit: HTTP_RATE_LIMITS.auth.limit,
    ttl: HTTP_RATE_LIMITS.auth.ttl,
  },
})
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('signup')
  @ApiOperation({
    summary: 'Create a new player account',
    description:
      'Register a player. `password` must be a **domain-separated SHA-256 hex digest** ' +
      '(64 lowercase hex chars) of `leaderboard-v1:` + email + `:` + password - never send plaintext. ' +
      'Enforce min 8 characters on plaintext before hashing. See the top-level **Password transmission** ' +
      'section for examples. Server stores argon2id(prehash).',
  })
  @ApiResponse({ status: 201, type: SignupUserResponse })
  @ApiResponse({ status: 400, type: ErrorResponse, description: 'Validation failure' })
  @ApiResponse({ status: 409, type: ErrorResponse, description: 'Email already registered' })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login and receive JWT token pair',
    description:
      'Authenticate with email + password prehash. `password` must be a **domain-separated SHA-256 hex digest** ' +
      '(64 lowercase hex chars) of `leaderboard-v1:` + email + `:` + password - never send plaintext. On success the server ' +
      'also sets an HttpOnly `refresh_token_<X-Session-Id>` cookie scoped to `/api/v1/auth` so the ' +
      'browser SDK can call `POST /auth/refresh` without exposing the refresh token to JavaScript. ' +
      'Non-browser clients can ignore the cookie and use `refresh_token` from the response body.',
  })
  @ApiHeader({
    name: 'X-Session-Id',
    required: false,
    description:
      'Optional session label (`a`, `b`, ...) for cookie scoping when multiple independent logical ' +
      'clients share one browser tab origin. Defaults to `default`. Pattern: `^[a-z0-9_-]{1,32}$`.',
  })
  @ApiResponse({
    status: 200,
    type: TokenPairResponse,
    description:
      'Token pair. Response also sets `Set-Cookie: refresh_token_<sid>=...; HttpOnly; SameSite=Lax; Path=/api/v1/auth`.',
  })
  @ApiResponse({ status: 401, type: ErrorResponse, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const pair = await this.authService.login(dto);
    const sessionId = readSessionId(req);
    const maxAge = Number(this.configService.get<number>('JWT_REFRESH_TTL') || 604_800);
    setRefreshCookie(reply, sessionId, pair.refresh_token, maxAge);
    return pair;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate refresh token and issue new token pair',
    description:
      'Refresh token can be provided in either the HttpOnly `refresh_token_<X-Session-Id>` cookie ' +
      '(preferred for browsers) or the `refresh_token` JSON body field (for API clients that cannot ' +
      'use cookies). Cookie takes precedence when both are present. On success a fresh cookie is set.',
  })
  @ApiHeader({
    name: 'X-Session-Id',
    required: false,
    description:
      'Session label matching the cookie name used at login. Defaults to `default`.',
  })
  @ApiResponse({
    status: 200,
    type: TokenPairResponse,
    description: 'New token pair; a rotated `refresh_token_<sid>` cookie is set.',
  })
  @ApiResponse({ status: 401, type: ErrorResponse, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const sessionId = readSessionId(req);
    const token = readRefreshCookie(req, sessionId) ?? dto.refresh_token;
    if (!token) {
      throw new UnauthorizedException('Refresh token missing');
    }
    try {
      const pair = await this.authService.refresh(token);
      const maxAge = Number(this.configService.get<number>('JWT_REFRESH_TTL') || 604_800);
      setRefreshCookie(reply, sessionId, pair.refresh_token, maxAge);
      return pair;
    } catch (err) {
      // Stale cookie would otherwise cause a permanent 401 loop.
      clearRefreshCookie(reply, sessionId);
      throw err;
    }
  }
}
