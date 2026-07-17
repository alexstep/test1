import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { LeaderboardService } from './leaderboard.service';
import { GamesService } from '@/games/games.service';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import {
  LeaderboardResponse,
  PlayerRankResponse,
  ErrorResponse,
} from '@/common/openapi/responses.dto';
import { HTTP_RATE_LIMITS } from '@/common/rate-limits';

@ApiTags('leaderboard')
@ApiBearerAuth()
@SkipThrottle({ auth: true, write: true })
@Throttle({
  read: {
    limit: HTTP_RATE_LIMITS.read.limit,
    ttl: HTTP_RATE_LIMITS.read.ttl,
  },
})
@Controller('leaderboard')
export class LeaderboardController {
  constructor(
    private readonly leaderboardService: LeaderboardService,
    private readonly gamesService: GamesService,
  ) {}

  @Get(':gameId')
  @ApiOperation({
    summary: 'Get top-N leaderboard for a game',
    description:
      'Supports cursor-based pagination (primary) and offset pagination (fallback). ' +
      'When `cursor` is provided, `offset` is ignored.',
  })
  @ApiParam({ name: 'gameId', format: 'uuid' })
  @ApiResponse({ status: 200, type: LeaderboardResponse })
  @ApiResponse({ status: 400, type: ErrorResponse, description: 'Invalid cursor format' })
  @ApiResponse({ status: 404, type: ErrorResponse, description: 'Game not found' })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async getLeaderboard(
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Query() query: LeaderboardQueryDto,
  ) {
    const game = await this.gamesService.findById(gameId);
    if (!game) {
      throw new NotFoundException('Game not found');
    }

    const limit = query.limit ?? 10;

    if (query.cursor) {
      return this.leaderboardService.getLeaderboardByCursor(
        gameId,
        query.cursor,
        limit,
      );
    }

    return this.leaderboardService.getLeaderboard(
      gameId,
      query.offset ?? 0,
      limit,
    );
  }

  @Get(':gameId/rank/:playerId')
  @ApiOperation({ summary: "Get a player's rank and score for a game" })
  @ApiParam({ name: 'gameId', format: 'uuid' })
  @ApiParam({ name: 'playerId', format: 'uuid' })
  @ApiResponse({ status: 200, type: PlayerRankResponse })
  @ApiResponse({
    status: 404,
    type: ErrorResponse,
    description: 'Game or player not found, or player has no score in this game',
  })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async getPlayerRank(
    @Param('gameId', ParseUUIDPipe) gameId: string,
    @Param('playerId', ParseUUIDPipe) playerId: string,
  ) {
    const game = await this.gamesService.findById(gameId);
    if (!game) {
      throw new NotFoundException('Game not found');
    }

    const result = await this.leaderboardService.getPlayerRank(gameId, playerId);
    if (!result) {
      throw new NotFoundException('Player has no score in this game');
    }
    return result;
  }
}
