import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { MatchesService } from './matches.service';
import { Match } from '@/database/entities/match.entity';
import { Game } from '@/database/entities/game.entity';
import { LeaderboardService } from '@/leaderboard/leaderboard.service';
import { MetricsService } from '@/metrics/metrics.service';

type MockFn = ReturnType<typeof mock>;

describe('MatchesService', () => {
  let service: MatchesService;
  let leaderboardService: {
    updateScoreAndPublish: MockFn;
    rebuildGameLeaderboard: MockFn;
  };
  let metricsService: { matchSubmitted: MockFn };
  let insertQb: {
    insert: MockFn;
    into: MockFn;
    values: MockFn;
    orIgnore: MockFn;
    returning: MockFn;
    execute: MockFn;
  };
  let managerFindOne: MockFn;
  let managerCreate: MockFn;
  let managerSave: MockFn;
  let matchRepoFindOne: MockFn;
  let queryRunner: {
    connect: MockFn;
    startTransaction: MockFn;
    commitTransaction: MockFn;
    rollbackTransaction: MockFn;
    release: MockFn;
    manager: {
      save: MockFn;
      create: MockFn;
      createQueryBuilder: MockFn;
      getRepository: MockFn;
      findOne: MockFn;
    };
  };

  const gameId = '11111111-1111-4111-8111-111111111111';
  const playerId = '22222222-2222-4222-8222-222222222222';
  const playerEmail = 'player@test.com';
  const idemKey = '33333333-3333-4333-8333-333333333333';
  const createdAt = new Date('2026-07-15T10:05:00Z');
  const savedId = '44444444-4444-4444-8444-444444444444';

  beforeEach(async () => {
    leaderboardService = {
      updateScoreAndPublish: mock(() =>
        Promise.resolve({
          newScore: 100,
          newRank: 1,
          previousRank: null,
          eventId: '1-0',
        }),
      ),
      rebuildGameLeaderboard: mock(() => Promise.resolve()),
    };
    metricsService = { matchSubmitted: mock() };

    matchRepoFindOne = mock();
    const matchRepo = { findOne: matchRepoFindOne };

    insertQb = {
      insert: mock(function (this: unknown) {
        return this;
      }),
      into: mock(function (this: unknown) {
        return this;
      }),
      values: mock(function (this: unknown) {
        return this;
      }),
      orIgnore: mock(function (this: unknown) {
        return this;
      }),
      returning: mock(function (this: unknown) {
        return this;
      }),
      execute: mock(),
    };

    managerFindOne = mock((entity: unknown) => {
      if (entity === Game) {
        return Promise.resolve({ id: gameId, name: 'Test' });
      }
      return Promise.resolve(null);
    });
    managerCreate = mock((_entity: unknown, v: Record<string, unknown>) => ({
      ...v,
    }));
    managerSave = mock((m: Match) =>
      Promise.resolve({
        ...m,
        id: savedId,
        createdAt,
      }),
    );

    queryRunner = {
      connect: mock(() => Promise.resolve()),
      startTransaction: mock(() => Promise.resolve()),
      commitTransaction: mock(() => Promise.resolve()),
      rollbackTransaction: mock(() => Promise.resolve()),
      release: mock(() => Promise.resolve()),
      manager: {
        save: managerSave,
        create: managerCreate,
        createQueryBuilder: mock(() => insertQb),
        getRepository: mock(() => matchRepo),
        findOne: managerFindOne,
      },
    };

    const dataSource = {
      createQueryRunner: mock(() => queryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MatchesService,
        { provide: LeaderboardService, useValue: leaderboardService },
        { provide: MetricsService, useValue: metricsService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(MatchesService);
  });

  it('throws NotFoundException when game missing (checked inside TX, rolls back)', async () => {
    managerFindOne.mockImplementationOnce(() => Promise.resolve(null));

    await expect(
      service.create({ game_id: gameId, score: 50 }, playerId, playerEmail),
    ).rejects.toThrow(NotFoundException);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(leaderboardService.updateScoreAndPublish).not.toHaveBeenCalled();
    expect(metricsService.matchSubmitted).not.toHaveBeenCalled();
  });

  it('creates match without idempotency key via queryRunner.manager and publishes update', async () => {
    const result = await service.create(
      { game_id: gameId, score: 50 },
      playerId,
      playerEmail,
      null,
    );

    expect(managerCreate).toHaveBeenCalledTimes(1);
    expect(managerCreate).toHaveBeenCalledWith(Match, {
      playerId,
      gameId,
      score: 50,
      idempotencyKey: null,
    });
    expect(managerSave).toHaveBeenCalledTimes(1);

    expect(result.replayed).toBe(false);
    expect(result.score).toBe(50);
    expect(result.created_at).toBe(createdAt.toISOString());
    expect(leaderboardService.updateScoreAndPublish).toHaveBeenCalledTimes(1);
    expect(leaderboardService.updateScoreAndPublish).toHaveBeenCalledWith(
      gameId,
      playerId,
      50,
      expect.objectContaining({
        type: 'leaderboard-update',
        game_id: gameId,
        player_id: playerId,
        email: playerEmail,
        delta_score: 50,
        timestamp: createdAt.toISOString(),
      }),
    );
    expect(metricsService.matchSubmitted).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('idempotency_key');
  });

  it('creates match with Idempotency-Key on first insert and uses saved.createdAt for event timestamp', async () => {
    const insertCreatedAt = new Date('2026-07-15T10:05:00Z');
    insertQb.execute.mockResolvedValueOnce({
      raw: [
        {
          id: '55555555-5555-4555-8555-555555555555',
          player_id: playerId,
          game_id: gameId,
          score: 75,
          idempotency_key: idemKey,
          created_at: insertCreatedAt,
        },
      ],
      identifiers: [{ id: '55555555-5555-4555-8555-555555555555' }],
    });

    const result = await service.create(
      { game_id: gameId, score: 75 },
      playerId,
      playerEmail,
      idemKey,
    );

    expect(result.replayed).toBe(false);
    expect(result.id).toBe('55555555-5555-4555-8555-555555555555');
    expect(leaderboardService.updateScoreAndPublish).toHaveBeenCalledTimes(1);
    expect(leaderboardService.updateScoreAndPublish).toHaveBeenCalledWith(
      gameId,
      playerId,
      75,
      expect.objectContaining({
        idempotency_key: idemKey,
        delta_score: 75,
        timestamp: insertCreatedAt.toISOString(),
      }),
    );
  });

  it('replays existing match on conflict without Redis side effects or metrics', async () => {
    insertQb.execute.mockResolvedValueOnce({ raw: [], identifiers: [] });
    matchRepoFindOne.mockResolvedValueOnce({
      id: '66666666-6666-4666-8666-666666666666',
      playerId,
      gameId,
      score: 75,
      idempotencyKey: idemKey,
      createdAt: new Date('2026-07-15T10:00:00Z'),
    });

    const result = await service.create(
      { game_id: gameId, score: 75 },
      playerId,
      playerEmail,
      idemKey,
    );

    expect(result.replayed).toBe(true);
    expect(result.id).toBe('66666666-6666-4666-8666-666666666666');
    expect(leaderboardService.updateScoreAndPublish).not.toHaveBeenCalled();
    expect(metricsService.matchSubmitted).not.toHaveBeenCalled();
    expect(leaderboardService.rebuildGameLeaderboard).not.toHaveBeenCalled();
  });

  it('throws ConflictException when concurrent winner never becomes visible', async () => {
    insertQb.execute.mockResolvedValueOnce({ raw: [], identifiers: [] });
    matchRepoFindOne.mockResolvedValue(null);

    await expect(
      service.create(
        { game_id: gameId, score: 75 },
        playerId,
        playerEmail,
        idemKey,
      ),
    ).rejects.toThrow(ConflictException);

    expect(leaderboardService.updateScoreAndPublish).not.toHaveBeenCalled();
    expect(metricsService.matchSubmitted).not.toHaveBeenCalled();
  });

  it('increments matchSubmitted even when Redis update ultimately fails, and schedules rebuild', async () => {
    leaderboardService.updateScoreAndPublish.mockImplementation(() =>
      Promise.reject(new Error('redis down')),
    );

    const result = await service.create(
      { game_id: gameId, score: 50 },
      playerId,
      playerEmail,
      null,
    );

    expect(result.replayed).toBe(false);
    expect(metricsService.matchSubmitted).toHaveBeenCalledTimes(1);
    expect(leaderboardService.updateScoreAndPublish).toHaveBeenCalledTimes(3);

    // Rebuild is fire-and-forget; give the scheduled microtask a chance to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(leaderboardService.rebuildGameLeaderboard).toHaveBeenCalledTimes(1);
    expect(leaderboardService.rebuildGameLeaderboard).toHaveBeenCalledWith(
      gameId,
    );
  });

  it('does not trigger rebuild when a transient Redis failure is followed by success', async () => {
    let calls = 0;
    leaderboardService.updateScoreAndPublish.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('transient'));
      return Promise.resolve({
        newScore: 50,
        newRank: 1,
        previousRank: null,
        eventId: '1-0',
      });
    });

    const result = await service.create(
      { game_id: gameId, score: 50 },
      playerId,
      playerEmail,
      null,
    );

    expect(result.replayed).toBe(false);
    expect(leaderboardService.updateScoreAndPublish).toHaveBeenCalledTimes(2);
    expect(metricsService.matchSubmitted).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 0));
    expect(leaderboardService.rebuildGameLeaderboard).not.toHaveBeenCalled();
  });
});
