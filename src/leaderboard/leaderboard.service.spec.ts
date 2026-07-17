import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  EVENT_SCHEMA_VERSION,
  LeaderboardService,
} from './leaderboard.service';
import { REDIS_DATA } from '@/redis/redis.module';
import { MetricsService } from '@/metrics/metrics.service';
import { Match } from '@/database/entities/match.entity';
import { Game } from '@/database/entities/game.entity';
import { User } from '@/database/entities/user.entity';
import { BadRequestException } from '@nestjs/common';

type MockFn = ReturnType<typeof mock>;

interface MockRedisData {
  exists: MockFn;
  zrevrank: MockFn;
  zincrby: MockFn;
  zrevrange: MockFn;
  zcard: MockFn;
  zscore: MockFn;
  del: MockFn;
  zadd: MockFn;
  send: MockFn;
  expire: MockFn;
}

interface MockUserRepo {
  find: MockFn;
  findOne: MockFn;
}

interface MockMetrics {
  observeLeaderboardUpdate: MockFn;
  observeLeaderboardRebuild: MockFn;
  redisEvalError: MockFn;
  wsReplayGap: MockFn;
}

/**
 * Dispatch `redisData.send(cmd, args)` to per-command handlers so tests
 * don't need to guess the call order of unrelated commands.
 */
function makeSendDispatcher(): {
  send: MockFn;
  on(command: string, handler: (args: string[]) => unknown): void;
} {
  const handlers = new Map<string, (args: string[]) => unknown>();
  const send = mock((cmd: string, args: string[]) => {
    const h = handlers.get(cmd);
    if (!h) {
      throw new Error(`Unmocked Redis command: ${cmd} ${JSON.stringify(args)}`);
    }
    return Promise.resolve(h(args));
  });
  return {
    send,
    on(command, handler) {
      handlers.set(command, handler);
    },
  };
}

describe('LeaderboardService', () => {
  let service: LeaderboardService;
  let redisData: MockRedisData;
  let userRepo: MockUserRepo;
  let metrics: MockMetrics;
  let sendDispatch: ReturnType<typeof makeSendDispatcher>;
  let matchQueryBuilder: {
    select: MockFn;
    addSelect: MockFn;
    where: MockFn;
    groupBy: MockFn;
    getRawMany: MockFn;
  };

  beforeEach(async () => {
    sendDispatch = makeSendDispatcher();
    // Sensible defaults so most tests don't have to configure every command.
    sendDispatch.on('SCRIPT', () => 'sha-1');
    sendDispatch.on('SET', () => 'OK');
    sendDispatch.on('ZADD', () => 1);
    sendDispatch.on('RENAME', () => 'OK');

    redisData = {
      exists: mock(() => Promise.resolve(true)),
      zrevrank: mock(),
      zincrby: mock(),
      zrevrange: mock(),
      zcard: mock(() => Promise.resolve(1)),
      zscore: mock(),
      del: mock(() => Promise.resolve(1)),
      zadd: mock(() => Promise.resolve(1)),
      send: sendDispatch.send,
      expire: mock(() => Promise.resolve(1)),
    };

    matchQueryBuilder = {
      select: mock(function (this: unknown) {
        return this;
      }),
      addSelect: mock(function (this: unknown) {
        return this;
      }),
      where: mock(function (this: unknown) {
        return this;
      }),
      groupBy: mock(function (this: unknown) {
        return this;
      }),
      getRawMany: mock(() => Promise.resolve([])),
    };

    userRepo = { find: mock(), findOne: mock() };
    const gameRepo = { find: mock(() => Promise.resolve([])) };
    metrics = {
      observeLeaderboardUpdate: mock(),
      observeLeaderboardRebuild: mock(),
      redisEvalError: mock(),
      wsReplayGap: mock(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaderboardService,
        { provide: REDIS_DATA, useValue: redisData },
        {
          provide: getRepositoryToken(Match),
          useValue: {
            createQueryBuilder: mock(() => matchQueryBuilder),
          },
        },
        { provide: getRepositoryToken(Game), useValue: gameRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    service = module.get<LeaderboardService>(LeaderboardService);
  });

  const eventBase = {
    type: 'leaderboard-update' as const,
    game_id: 'game-1',
    player_id: 'player-1',
    email: 'p1@test.com',
    delta_score: 50,
    timestamp: '2026-07-15T10:00:00.000Z',
  };

  describe('updateScoreAndPublish', () => {
    it('loads script then EVALSHA and maps ranks', async () => {
      sendDispatch.on('EVALSHA', () => [2, '150', 0, '1697000000000-0']);

      const result = await service.updateScoreAndPublish(
        'game-1',
        'player-1',
        50,
        eventBase,
      );

      expect(result).toEqual({
        newScore: 150,
        newRank: 1,
        previousRank: 3,
        eventId: '1697000000000-0',
      });
      expect(metrics.observeLeaderboardUpdate).toHaveBeenCalledTimes(1);

      const evalshaCall = sendDispatch.send.mock.calls.find(
        (c: unknown[]) => c[0] === 'EVALSHA',
      );
      expect(evalshaCall).toBeDefined();
      const args = evalshaCall![1] as string[];
      expect(args[0]).toBe('sha-1');
      expect(args[1]).toBe('3');
      expect(args[2]).toBe('leaderboard:game-1');
      expect(args[3]).toBe('leaderboard-events:game-1');
      expect(args[4]).toBe('leaderboard-updates:game-1');
      expect(args[5]).toBe('player-1');
      expect(args[6]).toBe('50');

      const payload = JSON.parse(args[7]!);
      expect(payload.schema_version).toBe(EVENT_SCHEMA_VERSION);
      expect(payload.type).toBe('leaderboard-update');
      expect(payload.delta_score).toBe(50);
    });

    it('accepts numeric ranks or string ranks from Lua', async () => {
      sendDispatch.on('EVALSHA', () => ['2', '150', '0', '1-0']);

      const result = await service.updateScoreAndPublish(
        'game-1',
        'player-1',
        50,
        eventBase,
      );

      expect(result.previousRank).toBe(3);
      expect(result.newRank).toBe(1);
    });

    it('handles first-time player (no previous rank)', async () => {
      sendDispatch.on('EVALSHA', () => [null, '50', 4, '1-0']);

      const result = await service.updateScoreAndPublish(
        'game-1',
        'player-new',
        50,
        { ...eventBase, player_id: 'player-new' },
      );
      expect(result).toEqual({
        newScore: 50,
        newRank: 5,
        previousRank: null,
        eventId: '1-0',
      });
    });

    it('falls back to EVAL on NOSCRIPT', async () => {
      let firstCall = true;
      sendDispatch.on('EVALSHA', () => {
        if (firstCall) {
          firstCall = false;
          throw new Error('NOSCRIPT No matching script');
        }
        return [0, '100', 0, '2-0'];
      });
      sendDispatch.on('EVAL', () => [0, '100', 0, '2-0']);

      const result = await service.updateScoreAndPublish(
        'game-1',
        'player-1',
        50,
        eventBase,
      );

      expect(result.eventId).toBe('2-0');
      expect(
        sendDispatch.send.mock.calls.some((c: unknown[]) => c[0] === 'EVAL'),
      ).toBe(true);
      expect(metrics.redisEvalError).not.toHaveBeenCalled();
    });

    it('counts non-NOSCRIPT eval errors as redis_eval_errors', async () => {
      sendDispatch.on('EVALSHA', () => {
        throw new Error('WRONGTYPE');
      });

      await expect(
        service.updateScoreAndPublish('game-1', 'player-1', 50, eventBase),
      ).rejects.toThrow('WRONGTYPE');
      expect(metrics.redisEvalError).toHaveBeenCalledTimes(1);
    });

    it('rejects non-positive delta', async () => {
      await expect(
        service.updateScoreAndPublish('game-1', 'player-1', 0, eventBase),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.updateScoreAndPublish('game-1', 'player-1', -10, eventBase),
      ).rejects.toThrow(BadRequestException);
      expect(sendDispatch.send).not.toHaveBeenCalled();
    });

    it('reuses cached SHA on subsequent calls', async () => {
      sendDispatch.on('EVALSHA', () => [0, '50', 0, '1-0']);

      await service.updateScoreAndPublish('game-1', 'player-1', 50, eventBase);
      await service.updateScoreAndPublish('game-1', 'player-1', 50, eventBase);

      const scriptLoads = sendDispatch.send.mock.calls.filter(
        (c: unknown[]) => c[0] === 'SCRIPT',
      );
      expect(scriptLoads).toHaveLength(1);
      const evalShas = sendDispatch.send.mock.calls.filter(
        (c: unknown[]) => c[0] === 'EVALSHA',
      );
      expect(evalShas).toHaveLength(2);
    });
  });

  describe('getLeaderboard', () => {
    it('returns entries with correct ranks via batched user lookup', async () => {
      redisData.zrevrange.mockResolvedValue([
        ['p1', 200],
        ['p2', 100],
      ]);
      redisData.zcard.mockResolvedValue(2);
      userRepo.find.mockResolvedValue([
        { id: 'p1', email: 'p1@test.com' },
        { id: 'p2', email: 'p2@test.com' },
      ]);

      const result = await service.getLeaderboard('game-1', 0, 10);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({
        rank: 1,
        player_id: 'p1',
        email: 'p1@test.com',
        score: 200,
      });
      expect(result.entries[1]).toEqual({
        rank: 2,
        player_id: 'p2',
        email: 'p2@test.com',
        score: 100,
      });
      expect(result.total).toBe(2);
      expect(result.next_cursor).toBeNull();
      expect(userRepo.find).toHaveBeenCalledTimes(1);
    });

    it('returns next_cursor on first page when total > limit', async () => {
      const limit = 2;

      redisData.zrevrange.mockResolvedValue([
        ['p1', 300],
        ['p2', 200],
        ['p3', 100],
      ]);
      redisData.zcard.mockResolvedValue(5);
      userRepo.find.mockResolvedValue([
        { id: 'p1', email: 'p1@test.com' },
        { id: 'p2', email: 'p2@test.com' },
      ]);

      const result = await service.getLeaderboard('game-1', 0, limit);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.player_id).toBe('p1');
      expect(result.entries[1]!.player_id).toBe('p2');
      expect(result.next_cursor).toBe(
        Buffer.from('v1:200:p2').toString('base64url'),
      );
      expect(redisData.zrevrange).toHaveBeenCalledWith(
        'leaderboard:game-1',
        0,
        limit,
        'WITHSCORES',
      );
    });

    it('returns null next_cursor on first page when total <= limit', async () => {
      const limit = 10;

      redisData.zrevrange.mockResolvedValue([
        ['p1', 200],
        ['p2', 100],
      ]);
      redisData.zcard.mockResolvedValue(2);
      userRepo.find.mockResolvedValue([
        { id: 'p1', email: 'p1@test.com' },
        { id: 'p2', email: 'p2@test.com' },
      ]);

      const result = await service.getLeaderboard('game-1', 0, limit);

      expect(result.entries).toHaveLength(2);
      expect(result.next_cursor).toBeNull();
    });

    it('page1 next_cursor fetches page 2 via getLeaderboardByCursor', async () => {
      const limit = 2;

      redisData.zrevrange.mockResolvedValueOnce([
        ['p1', 300],
        ['p2', 200],
        ['p3', 100],
      ]);
      redisData.zcard.mockResolvedValueOnce(5);
      userRepo.find.mockResolvedValueOnce([
        { id: 'p1', email: 'p1@test.com' },
        { id: 'p2', email: 'p2@test.com' },
      ]);

      const page1 = await service.getLeaderboard('game-1', 0, limit);
      expect(page1.next_cursor).not.toBeNull();

      redisData.zrevrank.mockResolvedValue(1);
      redisData.zscore.mockResolvedValue(200);
      redisData.zcard.mockResolvedValue(5);
      redisData.zrevrange.mockResolvedValueOnce([
        ['p3', 100],
        ['p4', 50],
      ]);
      userRepo.find.mockResolvedValueOnce([
        { id: 'p3', email: 'p3@test.com' },
        { id: 'p4', email: 'p4@test.com' },
      ]);

      const page2 = await service.getLeaderboardByCursor(
        'game-1',
        page1.next_cursor!,
        limit,
      );

      expect(page2.entries).toHaveLength(2);
      expect(page2.entries[0]).toEqual({
        rank: 3,
        player_id: 'p3',
        email: 'p3@test.com',
        score: 100,
      });
      expect(page2.entries[1]).toEqual({
        rank: 4,
        player_id: 'p4',
        email: 'p4@test.com',
        score: 50,
      });
    });

    it('rebuilds from Postgres when Redis key is missing', async () => {
      // Missing key → ZCARD 0 (same signal as an empty ZSET).
      redisData.zcard.mockResolvedValueOnce(0).mockResolvedValue(1);
      matchQueryBuilder.getRawMany.mockResolvedValueOnce([
        { player_id: 'p1', total_score: '200' },
      ]);

      redisData.zrevrange.mockResolvedValue([['p1', 200]]);
      userRepo.find.mockResolvedValue([{ id: 'p1', email: 'p1@test.com' }]);

      await service.getLeaderboard('game-1', 0, 10);

      expect(matchQueryBuilder.getRawMany).toHaveBeenCalled();
      const renameCall = sendDispatch.send.mock.calls.find(
        (c: unknown[]) => c[0] === 'RENAME',
      );
      expect(renameCall).toBeDefined();
      expect(renameCall![1]).toEqual([
        'leaderboard:game-1:rebuild',
        'leaderboard:game-1',
      ]);
    });

    it('rebuilds from Postgres when Redis sorted set is empty', async () => {
      redisData.zcard.mockResolvedValueOnce(0).mockResolvedValue(1);
      matchQueryBuilder.getRawMany.mockResolvedValueOnce([
        { player_id: 'p1', total_score: '150' },
      ]);

      redisData.zrevrange.mockResolvedValue([['p1', 150]]);
      userRepo.find.mockResolvedValue([{ id: 'p1', email: 'p1@test.com' }]);

      await service.getLeaderboard('game-1', 0, 10);

      expect(matchQueryBuilder.getRawMany).toHaveBeenCalled();
      expect(
        sendDispatch.send.mock.calls.some((c: unknown[]) => c[0] === 'RENAME'),
      ).toBe(true);
    });

    it('propagates rebuild errors instead of swallowing them', async () => {
      redisData.zcard.mockResolvedValueOnce(0);
      matchQueryBuilder.getRawMany.mockRejectedValueOnce(
        new Error('postgres down'),
      );

      await expect(service.getLeaderboard('game-1', 0, 10)).rejects.toThrow(
        'postgres down',
      );
    });
  });

  describe('rebuildGameLeaderboard', () => {
    it('skips rebuild when lock is not acquired', async () => {
      sendDispatch.on('SET', () => null);

      await service.rebuildGameLeaderboard('game-1');

      expect(matchQueryBuilder.getRawMany).not.toHaveBeenCalled();
      expect(
        sendDispatch.send.mock.calls.some((c: unknown[]) => c[0] === 'RENAME'),
      ).toBe(false);
    });

    it('builds into temp key and RENAMEs onto live key with batched ZADD', async () => {
      matchQueryBuilder.getRawMany.mockResolvedValueOnce([
        { player_id: 'p1', total_score: '100' },
        { player_id: 'p2', total_score: '200' },
      ]);

      await service.rebuildGameLeaderboard('game-1');

      const zaddCall = sendDispatch.send.mock.calls.find(
        (c: unknown[]) => c[0] === 'ZADD',
      );
      expect(zaddCall).toBeDefined();
      expect(zaddCall![1]).toEqual([
        'leaderboard:game-1:rebuild',
        '100',
        'p1',
        '200',
        'p2',
      ]);

      const renameCall = sendDispatch.send.mock.calls.find(
        (c: unknown[]) => c[0] === 'RENAME',
      );
      expect(renameCall).toBeDefined();
      expect(renameCall![1]).toEqual([
        'leaderboard:game-1:rebuild',
        'leaderboard:game-1',
      ]);

      expect(metrics.observeLeaderboardRebuild).toHaveBeenCalledTimes(1);
    });

    it('DELs the live key when Postgres has no matches for the game', async () => {
      matchQueryBuilder.getRawMany.mockResolvedValueOnce([]);

      await service.rebuildGameLeaderboard('game-1');

      expect(redisData.del).toHaveBeenCalledWith('leaderboard:game-1');
      expect(
        sendDispatch.send.mock.calls.some((c: unknown[]) => c[0] === 'RENAME'),
      ).toBe(false);
    });

    it('releases lock and cleans up temp key after successful rebuild', async () => {
      matchQueryBuilder.getRawMany.mockResolvedValueOnce([
        { player_id: 'p1', total_score: '100' },
      ]);

      await service.rebuildGameLeaderboard('game-1');

      expect(redisData.del).toHaveBeenCalledWith(
        'leaderboard-rebuild-lock:game-1',
      );
      expect(redisData.del).toHaveBeenCalledWith(
        'leaderboard:game-1:rebuild',
      );
    });
  });

  describe('rebuildAllLeaderboards', () => {
    it('skips games whose ZSET key already exists', async () => {
      const gameRepoRef = (
        service as unknown as { gameRepo: { find: MockFn } }
      ).gameRepo;
      gameRepoRef.find = mock(() =>
        Promise.resolve([{ id: 'g-warm' }, { id: 'g-cold' }]),
      );
      redisData.exists.mockImplementation((key: string) =>
        Promise.resolve(key === 'leaderboard:g-warm' ? 1 : 0),
      );
      matchQueryBuilder.getRawMany.mockResolvedValue([
        { player_id: 'p1', total_score: '10' },
      ]);

      await service.rebuildAllLeaderboards();

      const setCalls = sendDispatch.send.mock.calls.filter(
        (c: unknown[]) => c[0] === 'SET',
      );
      // Only the cold game acquires the rebuild lock.
      expect(setCalls).toHaveLength(1);
      expect((setCalls[0]![1] as string[])[0]).toBe(
        'leaderboard-rebuild-lock:g-cold',
      );
    });
  });

  describe('getLeaderboardByCursor', () => {
    const gameId = 'game-1';
    const limit = 2;

    function encodeCursor(score: number, playerId: string): string {
      return Buffer.from(`v1:${score}:${playerId}`).toString('base64url');
    }

    it('returns entries after cursor position with next_cursor when more results exist', async () => {
      const cursor = encodeCursor(200, 'p1');

      redisData.zrevrank.mockResolvedValue(0);
      redisData.zscore.mockResolvedValue(200);
      redisData.zcard.mockResolvedValue(5);
      redisData.zrevrange.mockResolvedValue([
        ['p2', 180],
        ['p3', 150],
        ['p4', 120],
      ]);
      userRepo.find.mockResolvedValue([
        { id: 'p2', email: 'p2@test.com' },
        { id: 'p3', email: 'p3@test.com' },
      ]);

      const result = await service.getLeaderboardByCursor(gameId, cursor, limit);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({
        rank: 2,
        player_id: 'p2',
        email: 'p2@test.com',
        score: 180,
      });
      expect(result.entries[1]).toEqual({
        rank: 3,
        player_id: 'p3',
        email: 'p3@test.com',
        score: 150,
      });
      expect(result.next_cursor).toBe(encodeCursor(150, 'p3'));
      expect(result.total).toBe(5);
      expect(userRepo.find).toHaveBeenCalledTimes(1);
    });

    it('returns null next_cursor on last page', async () => {
      const cursor = encodeCursor(150, 'p3');

      redisData.zrevrank.mockResolvedValue(2);
      redisData.zscore.mockResolvedValue(150);
      redisData.zcard.mockResolvedValue(4);
      redisData.zrevrange.mockResolvedValue([['p4', 120]]);
      userRepo.find.mockResolvedValue([{ id: 'p4', email: 'p4@test.com' }]);

      const result = await service.getLeaderboardByCursor(gameId, cursor, limit);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({
        rank: 4,
        player_id: 'p4',
        email: 'p4@test.com',
        score: 120,
      });
      expect(result.next_cursor).toBeNull();
    });

    it('throws BadRequestException for invalid cursor format', async () => {
      await expect(
        service.getLeaderboardByCursor(gameId, 'not-valid-base64!@#', limit),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when cursor player not in leaderboard', async () => {
      const cursor = encodeCursor(200, 'missing-player');

      redisData.zrevrank.mockResolvedValue(null);
      redisData.zcard.mockResolvedValue(5);

      await expect(
        service.getLeaderboardByCursor(gameId, cursor, limit),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when cursor score mismatches', async () => {
      const cursor = encodeCursor(200, 'p1');

      redisData.zrevrank.mockResolvedValue(0);
      redisData.zscore.mockResolvedValue(250);
      redisData.zcard.mockResolvedValue(5);

      await expect(
        service.getLeaderboardByCursor(gameId, cursor, limit),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('encodeCursor / decodeCursor', () => {
    it('round-trips correctly', () => {
      const encoded = service.encodeCursor(1500, 'abc-123');
      const decoded = service.decodeCursor(encoded);
      expect(decoded).toEqual({ score: 1500, playerId: 'abc-123' });
    });

    it('throws for malformed cursor', () => {
      expect(() => service.decodeCursor('!!!invalid')).toThrow(
        BadRequestException,
      );
    });

    it('throws for unversioned legacy score:id payload', () => {
      const legacy = Buffer.from('1500:abc-123').toString('base64url');
      expect(() => service.decodeCursor(legacy)).toThrow(BadRequestException);
    });

    it('throws for unknown cursor version', () => {
      const v2 = Buffer.from('v2:1500:abc-123').toString('base64url');
      expect(() => service.decodeCursor(v2)).toThrow(BadRequestException);
    });
  });

  describe('getPlayerRank', () => {
    it('returns player rank and score', async () => {
      redisData.zrevrank.mockResolvedValue(0);
      redisData.zscore.mockResolvedValue(500);
      userRepo.find.mockResolvedValue([
        { id: 'player-1', email: 'player@test.com' },
      ]);

      const result = await service.getPlayerRank('game-1', 'player-1');
      expect(result).toEqual({
        game_id: 'game-1',
        player_id: 'player-1',
        email: 'player@test.com',
        rank: 1,
        score: 500,
      });
    });

    it('returns null for player not in leaderboard', async () => {
      redisData.zrevrank.mockResolvedValue(null);
      const result = await service.getPlayerRank('game-1', 'unknown');
      expect(result).toBeNull();
    });

    it('rebuilds from Postgres before lookup when Redis key is missing', async () => {
      redisData.zcard.mockResolvedValueOnce(0);
      matchQueryBuilder.getRawMany.mockResolvedValueOnce([
        { player_id: 'player-1', total_score: '500' },
      ]);

      redisData.zrevrank.mockResolvedValue(0);
      redisData.zscore.mockResolvedValue(500);
      userRepo.find.mockResolvedValue([
        { id: 'player-1', email: 'player@test.com' },
      ]);

      const result = await service.getPlayerRank('game-1', 'player-1');

      expect(matchQueryBuilder.getRawMany).toHaveBeenCalled();
      expect(result).toEqual({
        game_id: 'game-1',
        player_id: 'player-1',
        email: 'player@test.com',
        rank: 1,
        score: 500,
      });
    });
  });

  describe('getEventsSince', () => {
    it('returns gap when oldest id is after lastEventId', async () => {
      sendDispatch.on('XRANGE', () => [['200-0', ['payload', '{}']]]);

      const result = await service.getEventsSince('game-1', '100-0');
      expect(result).toEqual({ ok: false, reason: 'gap' });
    });

    it('returns empty when stream has no entries', async () => {
      sendDispatch.on('XRANGE', () => []);

      const result = await service.getEventsSince('game-1', '100-0');
      expect(result).toEqual({ ok: false, reason: 'empty' });
    });

    it('replays events after lastEventId', async () => {
      const payload = {
        type: 'leaderboard-update',
        schema_version: 1,
        game_id: 'game-1',
        player_id: 'p1',
        email: 'p1@test.com',
        new_score: 50,
        new_rank: 1,
        previous_rank: null,
        delta_score: 50,
        timestamp: '2026-07-15T10:00:00Z',
      };
      let call = 0;
      sendDispatch.on('XRANGE', () => {
        call++;
        if (call === 1) return [['100-0', ['payload', '{}']]];
        return [['101-0', ['payload', JSON.stringify(payload)]]];
      });

      const result = await service.getEventsSince('game-1', '100-0');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.events).toHaveLength(1);
        expect(result.events[0]!.event_id).toBe('101-0');
        expect(result.events[0]!.new_score).toBe(50);
        expect(result.events[0]!.schema_version).toBe(1);
      }
    });
  });

  describe('getCurrentEventId', () => {
    it('returns latest stream id', async () => {
      sendDispatch.on('XREVRANGE', () => [['999-1', ['payload', '{}']]]);
      await expect(service.getCurrentEventId('game-1')).resolves.toBe('999-1');
    });

    it('returns 0-0 when stream empty', async () => {
      sendDispatch.on('XREVRANGE', () => []);
      await expect(service.getCurrentEventId('game-1')).resolves.toBe('0-0');
    });
  });

  describe('compareStreamIds', () => {
    it('orders by ms then sequence', () => {
      expect(service.compareStreamIds('100-0', '100-1')).toBeLessThan(0);
      expect(service.compareStreamIds('200-0', '100-9')).toBeGreaterThan(0);
      expect(service.compareStreamIds('1-0', '1-0')).toBe(0);
    });
  });
});
