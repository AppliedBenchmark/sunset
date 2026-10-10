// The CLI's composition root: wires the process and the bundled registry into the commands.
import formats from '../../registry/formats.yaml';
import models from '../../registry/models.yaml';
import { runCli } from './run.ts';

// `sunset scan | head` closes the pipe early. That ends the output, not the run, so the exit code
// still reports the scan.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
});

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stdoutStream: process.stdout,
  stderr: process.stderr,
  bundled: { models, formats },
});
