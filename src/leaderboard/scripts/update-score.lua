-- Atomic leaderboard update path.
--
-- Contract:
--   KEYS[1] leaderboard sorted set   (leaderboard:{gameId})
--   KEYS[2] events stream            (leaderboard-events:{gameId})
--   KEYS[3] pub/sub channel          (leaderboard-updates:{gameId})
--
--   ARGV[1] playerId
--   ARGV[2] delta score (integer, > 0; validated on the JS side)
--   ARGV[3] event base JSON (LeaderboardUpdateBase + schema_version)
--   ARGV[4] events MAXLEN (approximate, with ~)
--   ARGV[5] events TTL seconds
--
-- Why Lua and not pipelining from Node.js:
--   we need ZREVRANK before and after ZINCRBY plus a matching XADD and PUBLISH
--   in one hop. A concurrent ZINCRBY on the same key between our two ZREVRANKs
--   would corrupt previous_rank, and a crash between ZINCRBY and XADD would
--   leave the score written but no event to replay. EVAL keeps the whole thing
--   in a single Redis roundtrip that is atomic from the server perspective.

local previous_rank = redis.call('ZREVRANK', KEYS[1], ARGV[1])
local new_score     = redis.call('ZINCRBY',  KEYS[1], ARGV[2], ARGV[1])
local current_rank  = redis.call('ZREVRANK', KEYS[1], ARGV[1])

-- Enrich the base payload with the freshly computed rank/score fields.
local ev = cjson.decode(ARGV[3])
ev.new_score     = tonumber(new_score)
ev.new_rank      = (current_rank or 0) + 1
ev.previous_rank = previous_rank and (previous_rank + 1) or cjson.null

-- Append the event, cap the stream, and refresh its TTL so idle games get
-- garbage collected instead of growing forever.
local xadd_json = cjson.encode(ev)
local event_id  = redis.call('XADD', KEYS[2],
  'MAXLEN', '~', ARGV[4], '*', 'payload', xadd_json)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))

-- Publish with the stream id attached so subscribers can dedupe against replay.
ev.event_id = event_id
redis.call('PUBLISH', KEYS[3], cjson.encode(ev))

return { previous_rank, tostring(new_score), current_rank, event_id }
