import {
  Injectable,
  Inject,
  OnModuleInit,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { RedisClient } from '@/redis/redis.module';
import { REDIS_DATA } from '@/redis/redis.module';
import { MetricsService } from '@/metrics/metrics.service';
import { Match } from '@/database/entities/match.entity';
import { Game } from '@/database/entities/game.entity';
import { User } from '@/database/entities/user.entity';
import { redisKeys } from './redis-keys';
import UPDATE_SCORE_SCRIPT from './scripts/update-score.lua';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/** Bumped whenever the on-the-wire event shape changes in a breaking way. */
export const EVENT_SCHEMA_VERSION = 1;

export interface LeaderboardUpdate {
  type: 'leaderboard-update';
  schema_version: number;
  game_id: string;
  player_id: string;
  email: string;
  new_score: number;
  new_rank: number;
  previous_rank: number | null;
  delta_score: number;
  timestamp: string;
  /** Redis Streams entry id from XADD, format `<ms>-<seq>`. */
  event_id: string;
  /** Echo of client Idempotency-Key when present. */
  idempotency_key?: string;
}

/** Fields the caller must supply; the rest is filled by the Lua script or by the service. */
export type LeaderboardUpdateBase = Omit<
  LeaderboardUpdate,
  'new_score' | 'new_rank' | 'previous_rank' | 'event_id' | 'schema_version'
>;

export type EventsSinceResult =
  | { ok: true; events: LeaderboardUpdate[] }
  | { ok: false; reason: 'gap' | 'empty' };

export interface LeaderboardEntry {
  rank: number;
  player_id: string;
  email: string;
  score: number;
}

/** Raw Lua reply shape: `[prevRank|nil, newScoreStr, newRank|nil, eventId]`. */
type UpdateScriptReply = [
  number | string | null,
  number | string,
  number | string | null,
  string,
];

/** Call-specific inputs for the atomic update script. Keys and tunables are resolved inside. */
interface UpdateScriptInput {
  gameId: string;
  playerId: string;
  deltaScore: number;
  eventBase: LeaderboardUpdateBase;
}

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

const EVENTS_MAXLEN = 500;
const EVENTS_TTL_SECONDS = 900;
const REBUILD_LOCK_TTL_SECONDS = 60;

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

@Injectable()
export class LeaderboardService implements OnModuleInit {
  private readonly logger = new Logger(LeaderboardService.name);
  /** Cached SHA of UPDATE_SCORE_SCRIPT so hot writes use EVALSHA, not EVAL. */
  private updateScriptSha: string | null = null;

  constructor(
    @Inject(REDIS_DATA) private readonly redisData: RedisClient,
    @InjectRepository(Match) private readonly matchRepo: Repository<Match>,
    @InjectRepository(Game) private readonly gameRepo: Repository<Game>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    // Fire-and-forget so a cold Redis does not block API boot. Any request that
    // hits an empty key later gets a lazy rebuild via ensureLeaderboardBuilt.
    void this.rebuildAllLeaderboards().catch((error) => {
      this.logger.error(
        `Failed to rebuild leaderboards on startup: ${String(error)}`,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Writes (hot path)
  // ---------------------------------------------------------------------------

  /**
   * Atomically increment the player score, append the change to the events
   * stream, and publish to subscribers. See scripts/update-score.lua for why
   * these three steps must live in one EVAL.
   */
  async updateScoreAndPublish(
    gameId: string,
    playerId: string,
    deltaScore: number,
    eventBase: LeaderboardUpdateBase,
  ): Promise<{
    newScore: number;
    newRank: number;
    previousRank: number | null;
    eventId: string;
  }> {
    if (!Number.isFinite(deltaScore) || deltaScore <= 0) {
      throw new BadRequestException(
        'Score delta must be a positive finite number',
      );
    }

    const startedAt = Date.now();
    const raw = await this.evalUpdateScript({ gameId, playerId, deltaScore, eventBase});
    this.metrics.observeLeaderboardUpdate((Date.now() - startedAt) / 1000);

    // Lua returns 0-based ranks; convert to the 1-based ranks we expose in the API.
    const [prevRaw, scoreRaw, newRaw, eventId] = raw;
    const prevRank = prevRaw == null ? null : Number(prevRaw);
    const newRank = newRaw == null ? 0 : Number(newRaw);
    return {
      previousRank: prevRank == null ? null : prevRank + 1,
      newScore: Number(scoreRaw),
      newRank: newRank + 1,
      eventId,
    };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Offset-based page. Fine for the first few pages; use cursors for deep paging. */
  async getLeaderboard(gameId: string, offset: number, limit: number) {
    await this.ensureLeaderboardBuilt(gameId);

    const total = await this.redisData.zcard(redisKeys.leaderboard(gameId));
    const { entries, nextCursor } = await this.fetchPage(
      gameId,
      offset,
      offset + 1,
      limit,
    );

    return {
      game_id: gameId,
      entries,
      total,
      offset,
      limit,
      next_cursor: nextCursor,
    };
  }

  /**
   * Cursor-based page. The cursor pins (score, playerId), so appended data
   * cannot shift the page under the client and we skip the (offset, limit)
   * scan of a rapidly changing sorted set.
   */
  async getLeaderboardByCursor(gameId: string, cursor: string, limit: number) {
    await this.ensureLeaderboardBuilt(gameId);

    const { score: cursorScore, playerId: cursorPlayerId } =
      this.decodeCursor(cursor);
    const key = redisKeys.leaderboard(gameId);

    const [total, rank] = await Promise.all([
      this.redisData.zcard(key),
      this.redisData.zrevrank(key, cursorPlayerId),
    ]);
    if (rank === null) {
      throw new BadRequestException(
        'Invalid cursor: player not found in leaderboard',
      );
    }

    // Reject stale cursors: if the pinned player's score has since changed,
    // the surrounding ranks moved and continuing would silently skip rows.
    const memberScore = await this.redisData.zscore(key, cursorPlayerId);
    if (memberScore !== cursorScore) {
      throw new BadRequestException(
        'Invalid cursor: score mismatch (leaderboard may have changed)',
      );
    }

    // Cursor points at a specific row; start one position after it.
    const startIndex = rank + 1;
    const { entries, nextCursor } = await this.fetchPage(
      gameId,
      startIndex,
      startIndex + 1,
      limit,
    );

    return {
      game_id: gameId,
      entries,
      total,
      limit,
      next_cursor: nextCursor,
    };
  }

  /** Single-player lookup, primarily for player profile screens and rank widgets. */
  async getPlayerRank(gameId: string, playerId: string) {
    await this.ensureLeaderboardBuilt(gameId);

    const key = redisKeys.leaderboard(gameId);
    const rank = await this.redisData.zrevrank(key, playerId);
    if (rank === null) return null;

    const score = await this.redisData.zscore(key, playerId);
    const emailById = await this.emailsForPlayers([playerId]);

    return {
      game_id: gameId,
      player_id: playerId,
      email: emailById.get(playerId) || 'unknown',
      rank: rank + 1,
      score: score ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Real-time replay (Redis Streams)
  // ---------------------------------------------------------------------------

  /**
   * Replay events strictly after `lastEventId`.
   * Returns `{ ok: false }` when the buffer was trimmed past the cursor (gap)
   * or the stream is empty (expired); caller should fall back to a snapshot.
   */
  async getEventsSince(
    gameId: string,
    lastEventId: string,
  ): Promise<EventsSinceResult> {
    const key = redisKeys.events(gameId);

    try {
      // Cheap upfront check: if the oldest surviving entry is already newer
      // than the cursor, we lost history and must send a full snapshot.
      const oldest = (await this.redisData.send('XRANGE', [
        key,
        '-',
        '+',
        'COUNT',
        '1',
      ])) as [string, string[]][] | null;

      if (!oldest || oldest.length === 0) {
        return { ok: false, reason: 'empty' };
      }

      const oldestId = oldest[0]![0];
      if (this.compareStreamIds(oldestId, lastEventId) > 0) {
        return { ok: false, reason: 'gap' };
      }

      const raw = (await this.redisData.send('XRANGE', [
        key,
        `(${lastEventId}`,
        '+',
      ])) as [string, string[]][] | null;

      const events: LeaderboardUpdate[] = [];
      for (const entry of raw ?? []) {
        const eventId = entry[0];
        const fields = entry[1];
        const payloadIdx = fields.indexOf('payload');
        if (payloadIdx === -1 || payloadIdx + 1 >= fields.length) continue;
        try {
          const parsed = JSON.parse(fields[payloadIdx + 1]!) as LeaderboardUpdate;
          // Trust XADD's canonical id, not whatever the producer stamped.
          events.push({ ...parsed, event_id: eventId });
        } catch {
          this.logger.warn(`Failed to parse stream event ${eventId}`);
        }
      }

      return { ok: true, events };
    } catch (error) {
      this.logger.error(
        `getEventsSince failed for ${gameId}: ${String(error)}`,
      );
      return { ok: false, reason: 'empty' };
    }
  }

  /** Latest stream entry id, or `0-0` when the buffer is empty. */
  async getCurrentEventId(gameId: string): Promise<string> {
    const key = redisKeys.events(gameId);
    try {
      const raw = (await this.redisData.send('XREVRANGE', [
        key,
        '+',
        '-',
        'COUNT',
        '1',
      ])) as [string, string[]][] | null;
      if (!raw || raw.length === 0) return '0-0';
      return raw[0]![0];
    } catch (error) {
      this.logger.error(
        `getCurrentEventId failed for ${gameId}: ${String(error)}`,
      );
      return '0-0';
    }
  }

  /** Lexicographic-safe comparison of Redis Stream ids (`<ms>-<seq>`). */
  compareStreamIds(a: string, b: string): number {
    const [ams, aseq] = a.split('-').map(Number) as [number, number];
    const [bms, bseq] = b.split('-').map(Number) as [number, number];
    if (ams !== bms) return ams - bms;
    return aseq - bseq;
  }

  // ---------------------------------------------------------------------------
  // Rebuild (recovery path)
  // ---------------------------------------------------------------------------

  /**
   * Walk every known game and rebuild any that lacks a live ZSET. Called at
   * boot as a warm-up and expected to be a no-op on a healthy Redis restart.
   */
  async rebuildAllLeaderboards() {
    this.logger.log('Rebuilding leaderboards from Postgres...');
    const games = await this.gameRepo.find();

    let rebuilt = 0;
    for (const game of games) {
      if (await this.redisData.exists(redisKeys.leaderboard(game.id))) continue;
      await this.rebuildGameLeaderboard(game.id);
      rebuilt++;
    }
    this.logger.log(
      `Rebuilt leaderboards for ${rebuilt}/${games.length} games (rest already warm)`,
    );
  }

  /**
   * Rebuild one game's ZSET from `SUM(score)` per player.
   * Steps and their reasons:
   *   1. Grab a per-game lock so two replicas do not race the same rebuild.
   *   2. Aggregate scores in Postgres.
   *   3. Load them into a *temporary* key first, then RENAME it over the live
   *      key. Otherwise readers would briefly see an empty leaderboard and any
   *      concurrent ZINCRBY on the live key would be wiped by the snapshot.
   *   4. Always release the lock and delete the temp key, even on failure.
   */
  async rebuildGameLeaderboard(gameId: string) {
    const lockKey = redisKeys.rebuildLock(gameId);
    const acquired = await this.redisData.send('SET', [
      lockKey,
      '1',
      'NX',
      'EX',
      String(REBUILD_LOCK_TTL_SECONDS),
    ]);
    if (acquired !== 'OK') {
      this.logger.debug(
        `Skipping rebuild for game ${gameId}: lock held by another worker`,
      );
      return;
    }

    const startedAt = Date.now();
    const liveKey = redisKeys.leaderboard(gameId);
    const tempKey = redisKeys.leaderboardRebuild(gameId);

    try {
      const scores: { player_id: string; total_score: string }[] =
        await this.matchRepo
          .createQueryBuilder('m')
          .select('m.player_id', 'player_id')
          .addSelect('SUM(m.score)', 'total_score')
          .where('m.game_id = :gameId', { gameId })
          .groupBy('m.player_id')
          .getRawMany();

      if (scores.length === 0) {
        // No matches in Postgres; any stale ZSET in Redis must go too.
        await this.redisData.del(liveKey);
        return;
      }

      await this.redisData.del(tempKey);
      await this.redisData.send('ZADD', [
        tempKey,
        ...scores.flatMap((r) => [r.total_score, r.player_id]),
      ]);
      await this.redisData.send('RENAME', [tempKey, liveKey]);
    } finally {
      this.metrics.observeLeaderboardRebuild((Date.now() - startedAt) / 1000);
      // No-op after a successful RENAME; cleans up on failure paths.
      await this.redisData.del(tempKey).catch(() => {});
      await this.redisData.del(lockKey).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Cursor codec
  // ---------------------------------------------------------------------------

  /**
   * Opaque, URL-safe cursor. Payload is `v1:{score}:{playerId}` then base64url.
   *
   * Version prefix (`v1`) exists so we can change the on-the-wire shape later
   * (extra fields, different separators, JSON, …) without silently misparsing
   * cursors that clients still hold. Unknown versions fail closed with 400.
   *
   * Score is pinned alongside playerId so getLeaderboardByCursor can reject
   * stale cursors when the player's score has moved under them.
   */
  encodeCursor(score: number, playerId: string): string {
    return Buffer.from(`v1:${score}:${playerId}`).toString('base64url');
  }

  decodeCursor(cursor: string): { score: number; playerId: string } {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const parts = decoded.split(':');
      // v1:score:playerId - playerId is UUID (no colons); keep it that way or
      // switch the codec version when the id format needs colons.
      if (parts.length !== 3 || parts[0] !== 'v1') {
        throw new Error('unsupported cursor version or shape');
      }
      const score = Number(parts[1]);
      const playerId = parts[2]!;
      if (!Number.isFinite(score) || !playerId) {
        throw new Error('invalid parts');
      }
      return { score, playerId };
    } catch {
      throw new BadRequestException('Invalid cursor format');
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Lazy insurance for the first read after a Redis restart or eviction.
   * `ZCARD` is 0 for both a missing key and an empty ZSET, so one round-trip
   * covers both cases (no separate EXISTS).
   *
   * Residual race: between this ZCARD and a later read/write the live key can
   * still be DEL'd (e.g. concurrent rebuild with empty Postgres). Worst case is
   * an empty page or a second lazy rebuild on the next request - not stale
   * ranks from a half-built set (rebuild uses temp key + RENAME).
   */
  private async ensureLeaderboardBuilt(gameId: string): Promise<void> {
    const key = redisKeys.leaderboard(gameId);
    const count = await this.redisData.zcard(key);
    if (count === 0) {
      await this.rebuildGameLeaderboard(gameId);
    }
  }

  /**
   * Run the atomic update script. Prefer EVALSHA (script cached in Redis);
   * on NOSCRIPT (Redis flush/restart) fall back to EVAL and let the next call
   * re-cache the SHA. Keys, tunables, and wire-order flattening live here so
   * the callsite only passes what varies per request.
   */
  private async evalUpdateScript(
    input: UpdateScriptInput,
  ): Promise<UpdateScriptReply> {
    const keys = [
      redisKeys.leaderboard(input.gameId),
      redisKeys.events(input.gameId),
      redisKeys.channel(input.gameId),
    ];
    const argv = [
      input.playerId,
      String(input.deltaScore),
      JSON.stringify({
        ...input.eventBase,
        schema_version: EVENT_SCHEMA_VERSION,
      }),
      String(EVENTS_MAXLEN),
      String(EVENTS_TTL_SECONDS),
    ];
    const keysCount = String(keys.length);

    if (!this.updateScriptSha) {
      this.updateScriptSha = (await this.redisData.send('SCRIPT', [
        'LOAD',
        UPDATE_SCORE_SCRIPT,
      ])) as string;
    }

    try {
      return (await this.redisData.send('EVALSHA', [
        this.updateScriptSha,
        keysCount,
        ...keys,
        ...argv,
      ])) as UpdateScriptReply;
    } catch (error) {
      const msg = String(error);
      if (msg.includes('NOSCRIPT')) {
        this.updateScriptSha = null;
        return (await this.redisData.send('EVAL', [
          UPDATE_SCORE_SCRIPT,
          keysCount,
          ...keys,
          ...argv,
        ])) as UpdateScriptReply;
      }
      this.metrics.redisEvalError();
      throw error;
    }
  }

  /**
   * Batched Postgres lookup so we do not fan out N `SELECT email FROM users`
   * queries per page. Falls back to an empty map for callers that pass `[]`.
   */
  private async emailsForPlayers(
    playerIds: string[],
  ): Promise<Map<string, string>> {
    if (playerIds.length === 0) return new Map();
    const users = await this.userRepo.find({
      where: { id: In(playerIds) },
      select: ['id', 'email'],
    });
    return new Map(users.map((u) => [u.id, u.email]));
  }

  /**
   * Shared paging primitive for both offset and cursor variants.
   *
   * @param startIndex 0-based ZSET position of the first row to include.
   * @param firstRank  1-based rank we should report for that first row.
   *
   * We deliberately ask Redis for `limit + 1` rows (via `startIndex + limit`,
   * which is an inclusive upper bound in ZREVRANGE): if the extra row exists
   * there is another page, and we cut it off before returning.
   */
  private async fetchPage(
    gameId: string,
    startIndex: number,
    firstRank: number,
    limit: number,
  ): Promise<{ entries: LeaderboardEntry[]; nextCursor: string | null }> {
    const results = await this.redisData.zrevrange(
      redisKeys.leaderboard(gameId),
      startIndex,
      startIndex + limit,
      'WITHSCORES' as const,
    );

    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const emailById = await this.emailsForPlayers(page.map(([id]) => id));

    const entries: LeaderboardEntry[] = page.map(([playerId, score], i) => ({
      rank: firstRank + i,
      player_id: playerId,
      email: emailById.get(playerId) || 'unknown',
      score,
    }));

    const nextCursor =
      hasMore && entries.length > 0
        ? this.encodeCursor(
            entries[entries.length - 1]!.score,
            entries[entries.length - 1]!.player_id,
          )
        : null;

    return { entries, nextCursor };
  }
}
