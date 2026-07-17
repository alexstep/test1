import { Controller, Post, Get, Body } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { GamesService } from './games.service';
import { CreateGameDto } from './dto/create-game.dto';
import { GameResponse, ErrorResponse } from '@/common/openapi/responses.dto';
import { HTTP_RATE_LIMITS } from '@/common/rate-limits';

@ApiTags('games')
@ApiBearerAuth()
@Controller('games')
export class GamesController {
  constructor(private readonly gamesService: GamesService) {}

  @Post()
  @SkipThrottle({ auth: true, read: true })
  @Throttle({
    write: {
      limit: HTTP_RATE_LIMITS.write.limit,
      ttl: HTTP_RATE_LIMITS.write.ttl,
    },
  })
  @ApiOperation({ summary: 'Create a new game' })
  @ApiResponse({ status: 201, type: GameResponse })
  @ApiResponse({ status: 400, type: ErrorResponse, description: 'Validation failure' })
  @ApiResponse({ status: 409, type: ErrorResponse, description: 'Game name already exists' })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async create(@Body() dto: CreateGameDto) {
    return this.gamesService.create(dto);
  }

  @Get()
  @SkipThrottle({ auth: true, write: true })
  @Throttle({
    read: {
      limit: HTTP_RATE_LIMITS.read.limit,
      ttl: HTTP_RATE_LIMITS.read.ttl,
    },
  })
  @ApiOperation({ summary: 'List all games' })
  @ApiResponse({ status: 200, type: [GameResponse] })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async findAll() {
    return this.gamesService.findAll();
  }
}
