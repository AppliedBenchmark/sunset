// The Action's composition root: wires @actions/core and the bundled registry into runAction.
//
// The bundled registry is read from the Action's own checkout (`registry/` at the ref the workflow
// uses) rather than built into this file, so a registry change doesn't change the committed
// bundle. The CLI's bundle, built at release time, has the registry built in.
import { readFile } from 'node:fs/promises';
import * as core from '@actions/core';
import type { BundledData } from '../adapters/registry-source.ts';
import { printable, printableLines } from '../report/text.ts';
import { runAction } from './run.ts';

/** `dist/action/index.js` → `registry/` at the root of the Action's repository. */
const REGISTRY_DIR = new URL('../../registry/', import.meta.url);

async function readBundled(): Promise<BundledData> {
  const read = (name: string) => readFile(new URL(name, REGISTRY_DIR), 'utf8');
  const [models, formats] = await Promise.all([read('models.yaml'), read('formats.yaml')]);
  return { models, formats };
}

async function main(): Promise<void> {
  let bundled: BundledData;
  try {
    bundled = await readBundled();
  } catch (error) {
    core.setFailed(
      printableLines(
        `Sunset couldn't read the registry that comes with the Action: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return;
  }
  // Messages quote the scanned repository (file names, its config, its code) and the registry, and
  // the log keeps every control character in them, terminal escapes included. core.info writes its
  // text as it is, so a line break there could also start a workflow command; the other calls
  // escape line breaks, which the runner shows as line breaks.
  await runAction({
    input: (name) => core.getInput(name),
    env: process.env,
    logger: {
      info: (m) => core.info(printable(m)),
      warn: (m) => core.warning(printableLines(m)),
      debug: (m) => core.debug(printableLines(m)),
    },
    notice: (m) => core.notice(printableLines(m)),
    annotate: ({ level, message, title, ...properties }) => {
      const text = printableLines(message);
      const at = { ...properties, title: printableLines(title) };
      if (level === 'error') core.error(text, at);
      else if (level === 'warning') core.warning(text, at);
      else core.notice(text, at);
    },
    setOutput: (name, value) => core.setOutput(name, value),
    setFailed: (message) => core.setFailed(printableLines(message)),
    writeSummary: async (markdown) => {
      // Outside a runner there is no summary file to write to.
      if (process.env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(markdown).write();
    },
    bundled,
  });
}

await main();
