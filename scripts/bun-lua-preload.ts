/**
 * Registered via `preload` in bunfig.toml so `import X from './foo.lua'` works
 * during dev (`nest start`), unit tests (`bun test`), and `bun dist/main.js`.
 * The production bundle applies the same rule via prod-bundle.mjs so the
 * bundled output has the script text inlined and never touches the disk.
 */
import { plugin } from 'bun';
import { readFileSync } from 'node:fs';

plugin({
  name: 'lua-text-loader',
  setup(build) {
    build.onLoad({ filter: /\.lua$/ }, ({ path }) => ({
      loader: 'js',
      contents: `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`,
    }));
  },
});
