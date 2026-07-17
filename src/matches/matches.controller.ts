import {
  Controller,
  Post,
  Body,
  Request,
  Res,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiHeader,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { MatchesService } from './matches.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { MatchResponse, ErrorResponse } from '@/common/openapi/responses.dto';
import { IdempotencyKey } from '@/common/decorators/idempotency-key.decorator';
import { HTTP_RATE_LIMITS } from '@/common/rate-limits';

interface AuthenticatedRequest {
  user: { id: string; email: string };
}

@ApiTags('matches')
@ApiBearerAuth()
@SkipThrottle({ auth: true, read: true })
@Throttle({
  write: {
    limit: HTTP_RATE_LIMITS.write.limit,
    ttl: HTTP_RATE_LIMITS.write.ttl,
  },
})
@Controller('matches')
export class MatchesController {
  constructor(private readonly matchesService: MatchesService) {}

  @Post()
  @ApiOperation({
    summary: 'Submit a match result',
    description:
      'Player ID is extracted from the JWT - players cannot submit scores for others. ' +
      'Optional Idempotency-Key header dedupes retries (Stripe / IETF draft).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'UUID identifying this submission intent; retries return 200 + Idempotent-Replayed',
  })
  @ApiResponse({ status: 201, type: MatchResponse })
  @ApiResponse({ status: 200, type: MatchResponse, description: 'Idempotent replay' })
  @ApiResponse({ status: 400, type: ErrorResponse, description: 'Validation failure' })
  @ApiResponse({ status: 404, type: ErrorResponse, description: 'Game not found' })
  @ApiResponse({
    status: 409,
    type: ErrorResponse,
    description: 'Concurrent idempotent request still in progress',
  })
  @ApiResponse({ status: 429, type: ErrorResponse, description: 'Rate limit exceeded' })
  async create(
    @Body() dto: CreateMatchDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Request() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const result = await this.matchesService.create(
      dto,
      req.user.id,
      req.user.email,
      idempotencyKey,
    );

    const { replayed, ...body } = result;
    if (replayed) {
      res.status(HttpStatus.OK);
      res.header('Idempotent-Replayed', 'true');
    } else {
      res.status(HttpStatus.CREATED);
    }
    return body;
  }
}
