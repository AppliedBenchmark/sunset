// esbuild (build.mjs) and Vitest (vitest.config.ts) load .yaml imports as their text.
declare module '*.yaml' {
  const text: string;
  export default text;
}
