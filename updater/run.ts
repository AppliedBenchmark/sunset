// The registry updater's entry point (`npm run registry:update`); the command is in run-update.ts.
import { fileURLToPath } from 'node:url';
import { runUpdate } from './run-update.ts';

process.exitCode = await runUpdate({
  argv: process.argv.slice(2),
  env: process.env,
  registryDir: fileURLToPath(new URL('../registry', import.meta.url)),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
