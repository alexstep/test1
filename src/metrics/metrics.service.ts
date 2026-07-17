import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly registry = new Registry();
  private wsActiveConnections!: Gauge<string>;
  private matchesSubmittedTotal!: Counter<string>;
  private leaderboardUpdateDuration!: Histogram<string>;
  private leaderboardRebuildDuration!: Histogram<string>;
  private redisEvalErrorsTotal!: Counter<string>;
  private wsReplayGapTotal!: Counter<string>;

  onModuleInit() {
    collectDefaultMetrics({ register: this.registry });

    this.wsActiveConnections = new Gauge({
      name: 'ws_active_connections',
      help: 'Number of active WebSocket connections',
      labelNames: ['game_id'],
      registers: [this.registry],
    });

    this.matchesSubmittedTotal = new Counter({
      name: 'matches_submitted_total',
      help: 'Total number of match submissions',
      registers: [this.registry],
    });

    this.leaderboardUpdateDuration = new Histogram({
      name: 'leaderboard_update_duration_seconds',
      help: 'Duration of the atomic Lua updateScoreAndPublish call',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    this.leaderboardRebuildDuration = new Histogram({
      name: 'leaderboard_rebuild_duration_seconds',
      help: 'Duration of a per-game Postgres→Redis leaderboard rebuild',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });

    this.redisEvalErrorsTotal = new Counter({
      name: 'redis_eval_errors_total',
      help: 'Total Redis EVAL/EVALSHA errors (excluding recoverable NOSCRIPT)',
      registers: [this.registry],
    });

    this.wsReplayGapTotal = new Counter({
      name: 'ws_replay_gap_total',
      help: 'WebSocket resume attempts that fell back to snapshot',
      labelNames: ['reason'],
      registers: [this.registry],
    });
  }

  wsConnectionOpened(gameId: string) {
    this.wsActiveConnections.inc({ game_id: gameId });
  }

  wsConnectionClosed(gameId: string) {
    this.wsActiveConnections.dec({ game_id: gameId });
  }

  matchSubmitted() {
    this.matchesSubmittedTotal.inc();
  }

  observeLeaderboardUpdate(durationSeconds: number) {
    this.leaderboardUpdateDuration.observe(durationSeconds);
  }

  observeLeaderboardRebuild(durationSeconds: number) {
    this.leaderboardRebuildDuration.observe(durationSeconds);
  }

  redisEvalError() {
    this.redisEvalErrorsTotal.inc();
  }

  wsReplayGap(reason: 'gap' | 'empty') {
    this.wsReplayGapTotal.inc({ reason });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
