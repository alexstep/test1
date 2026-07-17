/**
 * Treat `.lua` imports as text. The actual loader lives in
 * `scripts/bun-lua-preload.ts` (runtime) and `scripts/prod-bundle.mjs` (bundle).
 */
declare module '*.lua' {
  const content: string;
  export default content;
}
