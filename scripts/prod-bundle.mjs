/**
 * Production bundle for the Docker runtime image.
 * Requires `bun run build` first (generates dist/ + swagger metadata).
 *
 * Usage: bun scripts/prod-bundle.mjs
 */

import { readFileSync } from 'node:fs';

process.env.NODE_ENV = 'production';

/**
 * Inline `.lua` sources as text at bundle time. Mirror of the runtime plugin in
 * scripts/bun-lua-preload.ts so the bundled binary is self-contained and never
 * has to read the script from disk.
 */
const luaTextPlugin = {
  name: 'lua-text-loader',
  setup(build) {
    build.onLoad({ filter: /\.lua$/ }, ({ path }) => ({
      loader: 'js',
      contents: `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`,
    }));
  },
};

/** Optional peers Nest/pg/Fastify try/catch-require; keep out of the bundle. */
const externals = [
  '@nestjs/microservices',
  '@nestjs/websockets',
  '@nestjs/platform-express',
  '@nestjs/graphql',
  'cache-manager',
  '@fastify/view',
  'pg-native',
  'class-transformer/storage',
  // pino worker must load from disk at runtime
  'thread-stream',
  'real-require',
];

const result = await Bun.build({
  entrypoints: ['./dist/main.js'],
  outdir: './bundle',
  target: 'bun',
  format: 'cjs',
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false,
  },
  keepNames: true,
  sourcemap: 'external',
  bytecode: true,
  external: externals,
  plugins: [luaTextPlugin],
});

if (!result.success) {
  console.error('bun build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  const sizeMb = (output.size / (1024 * 1024)).toFixed(2);
  console.log(`  ${output.path}  ${sizeMb} MB  (${output.kind})`);
}
