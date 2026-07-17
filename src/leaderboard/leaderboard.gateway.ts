import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { RedisClient } from '@/redis/redis.module';
import { REDIS_SUBSCRIBER } from '@/redis/redis.module';
import { WS_RATE_LIMITS } from '@/common/rate-limits';
import { LeaderboardService } from './leaderboard.service';
import { CHANNEL_PATTERN, redisKeys } from './redis-keys';
import { GamesService } from '@/games/games.service';
import { MetricsService } from '@/metrics/metrics.service';
import {
  checkAndBumpCounter,
  clientIpFromUpgrade,
  pruneExpiredCounters,
  type RateWindow,
} from './rate-limit.util';

interface JwtPayload {
  sub: string;
  email: string;
}

interface ClientMeta {
  gameId: string;
  userId: string;
  heartbeatInterval: ReturnType<typeof setInterval>;
  pongTimeout?: ReturnType<typeof setTimeout>;
  awaitingPong: boolean;
  msgCount: number;
  msgWindowStart: number;
}

interface AuthMessage {
  type: 'auth';
  token: string;
}

/** Redis Stream ID format: `<milliseconds>-<sequence>`. */
const STREAM_ID_RE = /^\d+-\d+$/;

/** Time allowed for the first `{ type: "auth", token }` message after upgrade. */
const AUTH_TIMEOUT_MS = 5_000;

/** Parse first-message auth payload; exported for unit tests. */
export function parseAuthMessage(raw: unknown): AuthMessage | null {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
    return null;
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  try {
    const msg = JSON.parse(text) as { type?: unknown; token?: unknown };
    if (msg.type !== 'auth') return null;
    if (typeof msg.token !== 'string' || msg.token.length === 0) return null;
    return { type: 'auth', token: msg.token };
  } catch {
    return null;
  }
}

@Injectable()
export class LeaderboardGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderboardGateway.name);
  private wss!: WebSocket.Server;
  private readonly gameRooms = new Map<string, Set<WebSocket>>();
  private readonly clientMeta = new WeakMap<WebSocket, ClientMeta>();
  private readonly upgradeByIp = new Map<string, RateWindow>();
  private readonly pendingMsgRate = new WeakMap<WebSocket, RateWindow>();
  private upgradePruneCounter = 0;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly jwtService: JwtService,
    private readonly gamesService: GamesService,
    private readonly leaderboardService: LeaderboardService,
    private readonly metricsService: MetricsService,
    @Inject(REDIS_SUBSCRIBER) private readonly redisSub: RedisClient,
  ) {}

  onModuleInit() {
    const server = this.httpAdapterHost.httpAdapter.getHttpServer() as import('http').Server;
    this.wss = new WebSocket.Server({ noServer: true });

    server.on(
      'upgrade',
      (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        this.handleUpgrade(req, socket, head);
      },
    );

    this.logger.log('WebSocket gateway initialized');
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const pathMatch = url.pathname.match(
      /^\/ws\/leaderboard\/([0-9a-f-]{36})$/i,
    );
    if (!pathMatch) return;

    const ip = clientIpFromUpgrade(req.headers, req.socket.remoteAddress);
    this.upgradePruneCounter += 1;
    if (this.upgradePruneCounter % 64 === 0) {
      pruneExpiredCounters(this.upgradeByIp);
    }
    if (
      !checkAndBumpCounter(
        this.upgradeByIp,
        ip,
        WS_RATE_LIMITS.upgradePerIp.limit,
        WS_RATE_LIMITS.upgradePerIp.windowMs,
      )
    ) {
      socket.write(
        'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
      return;
    }

    const gameId = pathMatch[1]!;
    const lastEventIdRaw = url.searchParams.get('last_event_id');
    let lastEventId: string | null = null;
    if (lastEventIdRaw !== null && lastEventIdRaw !== '') {
      if (!STREAM_ID_RE.test(lastEventIdRaw)) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.close(4000, 'Invalid last_event_id');
        });
        return;
      }
      lastEventId = lastEventIdRaw;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onPendingConnection(ws, gameId, lastEventId);
    });
  }

  /** Returns false if the socket was closed for exceeding the message rate. */
  private bumpMessageRate(ws: WebSocket, meta?: ClientMeta): boolean {
    const limit = WS_RATE_LIMITS.messagesPerConnection.limit;
    const windowMs = WS_RATE_LIMITS.messagesPerConnection.windowMs;
    const now = Date.now();

    if (!meta) {
      // Pending-auth path: track on the socket via a lightweight WeakMap entry.
      let pending = this.pendingMsgRate.get(ws);
      if (!pending || now >= pending.resetAt) {
        pending = { count: 1, resetAt: now + windowMs };
        this.pendingMsgRate.set(ws, pending);
        return true;
      }
      if (pending.count >= limit) {
        ws.close(1008, 'Rate limit exceeded');
        return false;
      }
      pending.count += 1;
      return true;
    }

    if (now - meta.msgWindowStart >= windowMs) {
      meta.msgWindowStart = now;
      meta.msgCount = 1;
      return true;
    }
    meta.msgCount += 1;
    if (meta.msgCount > limit) {
      ws.close(1008, 'Rate limit exceeded');
      return false;
    }
    return true;
  }

  /**
   * Unauthenticated socket: wait for `{ type: "auth", token }` before joining
   * a room or sending snapshot/heartbeat.
   */
  private onPendingConnection(
    ws: WebSocket,
    gameId: string,
    lastEventId: string | null,
  ) {
    let settled = false;
    let authTimeout: ReturnType<typeof setTimeout>;

    const onEarlyClose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimeout);
      ws.off('message', onMessage);
    };

    const onMessage = (data: WebSocket.RawData) => {
      if (settled) return;
      if (!this.bumpMessageRate(ws)) return;
      settled = true;
      clearTimeout(authTimeout);
      ws.off('message', onMessage);
      ws.off('close', onEarlyClose);

      const auth = parseAuthMessage(data);
      if (!auth) {
        ws.close(4001, 'Authentication required');
        return;
      }

      let payload: JwtPayload;
      try {
        payload = this.jwtService.verify<JwtPayload>(auth.token);
      } catch {
        ws.close(4003, 'Token expired or invalid');
        return;
      }

      this.gamesService
        .findById(gameId)
        .then((game) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!game) {
            ws.close(4004, 'Game not found');
            return;
          }
          return this.onConnection(ws, payload, gameId, lastEventId);
        })
        .catch((err) => {
          this.logger.error(`Connection setup failed: ${String(err)}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Internal error');
          }
        });
    };

    authTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.off('message', onMessage);
      ws.off('close', onEarlyClose);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4001, 'Authentication required');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', onMessage);
    ws.on('close', onEarlyClose);
    ws.on('error', (err) => {
      this.logger.warn(`WebSocket error (pending auth): ${String(err)}`);
    });
  }

  private async onConnection(
    ws: WebSocket,
    payload: JwtPayload,
    gameId: string,
    lastEventId: string | null,
  ) {
    let room = this.gameRooms.get(gameId);
    const isFirstForGame = !room;
    if (!room) {
      room = new Set();
      this.gameRooms.set(gameId, room);
    }
    room.add(ws);

    const heartbeatInterval = setInterval(() => this.sendPing(ws), 30_000);
    const meta: ClientMeta = {
      gameId,
      userId: payload.sub,
      heartbeatInterval,
      awaitingPong: false,
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    this.clientMeta.set(ws, meta);

    this.metricsService.wsConnectionOpened(gameId);

    ws.on('close', () => this.onDisconnect(ws));
    ws.on('error', (err) => {
      this.logger.warn(`WebSocket error: ${String(err)}`);
    });
    ws.on('message', (data) => {
      if (!this.bumpMessageRate(ws, meta)) return;
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === 'pong') {
          meta.awaitingPong = false;
          if (meta.pongTimeout) {
            clearTimeout(meta.pongTimeout);
            meta.pongTimeout = undefined;
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    if (isFirstForGame) {
      const channel = redisKeys.channel(gameId);
      try {
        await this.redisSub.subscribe(channel, (message, ch) =>
          this.handleRedisMessage(ch, message),
        );
        this.logger.log(`Subscribed to ${channel}`);
      } catch (err) {
        this.logger.error(`Redis subscribe failed: ${String(err)}`);
      }
    }

    if (lastEventId) {
      const replay = await this.leaderboardService.getEventsSince(
        gameId,
        lastEventId,
      );
      if (replay.ok) {
        for (const update of replay.events) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(update));
          }
        }
        return;
      }
      this.metricsService.wsReplayGap(replay.reason);
      this.logger.debug(
        `Resume gap for game ${gameId} (${replay.reason}); sending snapshot`,
      );
    }

    await this.sendSnapshot(ws, gameId);
  }

  private async sendSnapshot(ws: WebSocket, gameId: string) {
    try {
      const [snapshot, currentEventId] = await Promise.all([
        this.leaderboardService.getLeaderboard(gameId, 0, 10),
        this.leaderboardService.getCurrentEventId(gameId),
      ]);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'leaderboard-snapshot',
            game_id: gameId,
            entries: snapshot.entries,
            current_event_id: currentEventId,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    } catch (err) {
      this.logger.error(`Failed to send snapshot: ${String(err)}`);
    }
  }

  private sendPing(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const meta = this.clientMeta.get(ws);
    if (!meta) return;

    if (meta.awaitingPong) {
      ws.close(1000, 'Heartbeat timeout');
      return;
    }

    ws.send(
      JSON.stringify({
        type: 'ping',
        timestamp: new Date().toISOString(),
      }),
    );

    meta.awaitingPong = true;
    meta.pongTimeout = setTimeout(() => {
      if (meta.awaitingPong && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Heartbeat timeout');
      }
    }, 10_000);
  }

  private onDisconnect(ws: WebSocket) {
    const meta = this.clientMeta.get(ws);
    if (!meta) return;

    clearInterval(meta.heartbeatInterval);
    if (meta.pongTimeout) clearTimeout(meta.pongTimeout);
    this.clientMeta.delete(ws);

    this.metricsService.wsConnectionClosed(meta.gameId);

    const room = this.gameRooms.get(meta.gameId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) {
        this.gameRooms.delete(meta.gameId);
        const channel = redisKeys.channel(meta.gameId);
        this.redisSub.unsubscribe(channel).catch((err) => {
          this.logger.error(`Redis unsubscribe failed: ${String(err)}`);
        });
        this.logger.log(`Unsubscribed from ${channel}`);
      }
    }
  }

  private handleRedisMessage(channel: string, message: string) {
    const chanMatch = channel.match(CHANNEL_PATTERN);
    if (!chanMatch) return;

    const gameId = chanMatch[1]!;
    const room = this.gameRooms.get(gameId);
    if (!room) return;

    for (const client of room) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  onModuleDestroy() {
    for (const [gameId, room] of this.gameRooms) {
      for (const client of room) {
        const meta = this.clientMeta.get(client);
        if (meta) {
          clearInterval(meta.heartbeatInterval);
          if (meta.pongTimeout) clearTimeout(meta.pongTimeout);
        }
        client.close(1001, 'Server shutting down');
      }
      this.redisSub.unsubscribe(redisKeys.channel(gameId)).catch(() => {});
    }
    this.gameRooms.clear();
    this.wss?.close();
    this.logger.log('WebSocket gateway shut down');
  }
}
