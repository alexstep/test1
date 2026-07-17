import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { Match } from '@/database/entities/match.entity';
import { Game } from '@/database/entities/game.entity';
import { LeaderboardService } from '@/leaderboard/leaderboard.service';
import { MetricsService } from '@/metrics/metrics.service';
import { CreateMatchDto } from './dto/create-match.dto';

/**
 * After ON CONFLICT DO NOTHING the winning INSERT may not have committed yet,
 * so the loser needs a brief retry before it can read the row under
 * READ COMMITTED. Kept short: idempotent replays should be near-instant.
 */
const IDEMPOTENCY_READ_DELAYS_MS = [0, 50, 100] as const;

/**
 * Redis leaderboard update runs after the Postgres commit. A transient blip
 * shouldn't force the caller to resubmit the match, and a repeated blip
 * should trigger a full rebuild rather than leave the ZSET permanently stale.
 */
const REDIS_UPDATE_DELAYS_MS = [0, 50, 150] as const;

export interface MatchCreateResult {
  id: string;
  player_id: string;
  game_id: string;
  score: number;
  created_at: string;
  replayed: boolean;
}

@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);

  constructor(
    private readonly leaderboardService: LeaderboardService,
    private readonly metricsService: MetricsService,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    dto: CreateMatchDto,
    playerId: string,
    playerEmail: string,
    idempotencyKey: string | null = null,
  ): Promise<MatchCreateResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: Match;
    let replayed = false;

    try {
      const game = await queryRunner.manager.findOne(Game, {
        where: { id: dto.game_id },
      });
      if (!game) {
        throw new NotFoundException('Game not found');
      }

      if (idempotencyKey) {
        const insertResult = await queryRunner.manager
          .createQueryBuilder()
          .insert()
          .into(Match)
          .values({
            playerId,
            gameId: dto.game_id,
            score: dto.score,
            idempotencyKey,
          })
          .orIgnore()
          .returning([
            'id',
            'playerId',
            'gameId',
            'score',
            'idempotencyKey',
            'createdAt',
          ])
          .execute();

        const rows = insertResult.raw as Array<{
          id: string;
          player_id: string;
          game_id: string;
          score: number;
          idempotency_key: string | null;
          created_at: Date | string;
        }>;

        if (rows.length === 0) {
          saved = await this.findExistingWithRetry(
            queryRunner.manager.getRepository(Match),
            playerId,
            idempotencyKey,
          );
          replayed = true;
        } else {
          const row = rows[0]!;
          saved = {
            id: row.id,
            playerId: row.player_id,
            gameId: row.game_id,
            score: row.score,
            idempotencyKey: row.idempotency_key,
            createdAt: new Date(row.created_at),
          } as Match;
        }
      } else {
        const match = queryRunner.manager.create(Match, {
          playerId,
          gameId: dto.game_id,
          score: dto.score,
          idempotencyKey: null,
        });
        saved = await queryRunner.manager.save(match);
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    if (replayed) {
      return this.toResult(saved, true);
    }

    // Match is durably committed; count the submission before touching Redis
    // so a Redis outage never hides real match throughput from monitoring.
    this.metricsService.matchSubmitted();

    await this.updateLeaderboardWithRetry(saved, playerEmail, idempotencyKey);

    return this.toResult(saved, false);
  }

  private async updateLeaderboardWithRetry(
    saved: Match,
    playerEmail: string,
    idempotencyKey: string | null,
  ): Promise<void> {
    let lastError: unknown = null;
    for (const delay of REDIS_UPDATE_DELAYS_MS) {
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        await this.leaderboardService.updateScoreAndPublish(
          saved.gameId,
          saved.playerId,
          saved.score,
          {
            type: 'leaderboard-update',
            game_id: saved.gameId,
            player_id: saved.playerId,
            email: playerEmail,
            delta_score: saved.score,
            timestamp: saved.createdAt.toISOString(),
            idempotency_key: idempotencyKey ?? undefined,
          },
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.logger.error(
      `Redis leaderboard update failed after match saved (matchId=${saved.id}, gameId=${saved.gameId}); scheduling rebuild`,
      lastError instanceof Error ? lastError.stack : String(lastError),
    );

    // Repair path: rebuild the ZSET from Postgres SUM(score). Same primitive
    // used on startup and on lazy reads, so failed replicas eventually converge
    // without an Outbox/worker for this assignment's scope.
    void this.leaderboardService
      .rebuildGameLeaderboard(saved.gameId)
      .catch((error) => {
        this.logger.error(
          `Fallback rebuildGameLeaderboard failed for game ${saved.gameId}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  private toResult(match: Match, replayed: boolean): MatchCreateResult {
    return {
      id: match.id,
      player_id: match.playerId,
      game_id: match.gameId,
      score: match.score,
      created_at: match.createdAt.toISOString(),
      replayed,
    };
  }

  private async findExistingWithRetry(
    repo: Repository<Match>,
    playerId: string,
    idempotencyKey: string,
  ): Promise<Match> {
    for (const delay of IDEMPOTENCY_READ_DELAYS_MS) {
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      const existing = await repo.findOne({
        where: { playerId, idempotencyKey },
      });
      if (existing) return existing;
    }
    throw new ConflictException(
      'Idempotent request in progress; retry shortly',
    );
  }
}
