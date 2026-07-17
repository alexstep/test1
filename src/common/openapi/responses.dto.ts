import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SignupUserResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'player@example.com' })
  email!: string;

  @ApiProperty({ example: '2026-07-15T10:00:00Z' })
  created_at!: string;
}

export class TokenPairResponse {
  @ApiProperty({ example: 'jwt...' })
  access_token!: string;

  @ApiProperty({ example: 'opaque-token' })
  refresh_token!: string;

  @ApiProperty({ example: 900 })
  expires_in!: number;
}

export class GameResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Space Invaders' })
  name!: string;

  @ApiPropertyOptional({ example: 'Classic arcade shooter', nullable: true })
  description!: string | null;

  @ApiProperty({ example: '2026-07-15T10:00:00Z' })
  created_at!: string;
}

export class MatchResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  player_id!: string;

  @ApiProperty({ format: 'uuid' })
  game_id!: string;

  @ApiProperty({ example: 1500 })
  score!: number;

  @ApiProperty({ example: '2026-07-15T10:05:00Z' })
  created_at!: string;
}

export class LeaderboardEntry {
  @ApiProperty({ example: 1 })
  rank!: number;

  @ApiProperty({ format: 'uuid' })
  player_id!: string;

  @ApiProperty({ example: 'top@example.com' })
  email!: string;

  @ApiProperty({ example: 15000 })
  score!: number;
}

export class LeaderboardResponse {
  @ApiProperty({ format: 'uuid' })
  game_id!: string;

  @ApiProperty({ type: [LeaderboardEntry] })
  entries!: LeaderboardEntry[];

  @ApiProperty({ example: 150 })
  total!: number;

  @ApiProperty({ example: 10 })
  limit!: number;

  @ApiPropertyOptional({ example: 0, description: 'Present when using offset pagination' })
  offset?: number;

  @ApiPropertyOptional({
    example: 'ZXlKelkyOXlaU0k2TVRVD...',
    nullable: true,
    description: 'Opaque cursor for next page; null on last page',
  })
  next_cursor?: string | null;
}

export class PlayerRankResponse {
  @ApiProperty({ format: 'uuid' })
  game_id!: string;

  @ApiProperty({ format: 'uuid' })
  player_id!: string;

  @ApiProperty({ example: 'player@example.com' })
  email!: string;

  @ApiProperty({ example: 42 })
  rank!: number;

  @ApiProperty({ example: 5000 })
  score!: number;
}

export class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ example: 3600 })
  uptime!: number;

  @ApiProperty({ example: 'api-1' })
  hostname!: string;
}

export class ErrorField {
  @ApiProperty({ example: 'email' })
  field!: string;

  @ApiProperty({ example: 'must be a valid email address' })
  message!: string;
}

export class ErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;

  @ApiPropertyOptional({ type: [ErrorField] })
  errors?: ErrorField[];
}
