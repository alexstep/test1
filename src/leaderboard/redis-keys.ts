/**
 * Single source of truth for Redis key names used by the leaderboard subsystem.
 * Callers must never build these strings by hand: a typo in one place would
 * silently split traffic between two keys (read misses, dropped publishes,
 * stale rebuild locks) and cost hours to debug.
 */
export const redisKeys = {
  /** Sorted set with player total scores per game. Written by the Lua updater. */
  leaderboard: (gameId: string) => `leaderboard:${gameId}`,

  /** Temporary ZSET built during a rebuild, then atomically RENAMEd over the live key. */
  leaderboardRebuild: (gameId: string) => `leaderboard:${gameId}:rebuild`,

  /** Stream buffer of the most recent update events, replayed on WS reconnect. */
  events: (gameId: string) => `leaderboard-events:${gameId}`,

  /** Pub/sub channel that fans out live updates across replicas. */
  channel: (gameId: string) => `leaderboard-updates:${gameId}`,

  /** SET NX EX lock that prevents two replicas from rebuilding the same game. */
  rebuildLock: (gameId: string) => `leaderboard-rebuild-lock:${gameId}`,
} as const;

/** Regex counterpart of `redisKeys.channel(...)`, used to route incoming pub/sub messages. */
export const CHANNEL_PATTERN = /^leaderboard-updates:(.+)$/;
