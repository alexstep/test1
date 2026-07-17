# ---------- deps: install dev+prod (needed for nest build swagger plugin) ----------
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# ---------- builder: nest build → bun bundle ----------
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock* tsconfig.json nest-cli.json .swcrc ./
COPY src ./src
COPY scripts ./scripts

# nest build generates src/metadata.ts (swagger plugin) and dist/ (SWC).
# dist is unused at runtime; metadata is required for the bun bundle.
RUN bun run build

# Production artifact: minified bundle + JSC bytecode (.jsc).
# Bytecode is compiled at build time so cold start skips parse/compile of the Nest bundle.
RUN bun run prod-bundle

# ---------- runtime: slim image without node_modules ----------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/bundle ./bundle
# pino/thread-stream spawns a Worker from an on-disk path; keep those packages external.
COPY --from=builder /app/node_modules/thread-stream ./node_modules/thread-stream
COPY --from=builder /app/node_modules/real-require ./node_modules/real-require
COPY public ./public
EXPOSE 3000
# Bun automatically loads bundle/main.js.jsc next to bundle/main.js
CMD ["bun", "bundle/main.js"]
