// The CLI's commands. Arguments are parsed with `util.parseArgs`. Reports go to stdout
// or `--output`; logs go to stderr, so `--format json` can be piped.
//
// Exit codes: 0 no findings at or above fail-on, 1 findings at or above fail-on,
// 2 a usage or config error, 3 an internal error.
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { fixedClock, systemClock } from '../adapters/clock.ts';
import { loadConfigFile } from '../adapters/config-file.ts';
import { createGit } from '../adapters/git.ts';
import { createHttpClient } from '../adapters/http.ts';
import { validateRegistryDir } from '../adapters/registry-files.ts';
import {
  type BundledData,
  createRegistrySource,
  parseRegistry,
} from '../adapters/registry-source.ts';
import { terminalStyle } from '../adapters/terminal-style.ts';
import { QUIET } from '../adapters/yaml-options.ts';
import { rebaseResult, repositoryPrefix } from '../app/rebase.ts';
import { reportContext, runScan } from '../app/scan.ts';
import {
  ConfigError,
  failingFindings,
  type Overrides,
  parseFailOn,
  parsePlatforms,
  parseRegistryMode,
  resolveSettings,
} from '../core/config.ts';
import { daysBetween } from '../core/dates.ts';
import type { Clock, Logger } from '../core/ports.ts';
import { type RegistryIssue, validateRegistry } from '../core/registry/validate.ts';
import type { IsoDate } from '../core/types.ts';
import { plural } from '../report/common.ts';
import { jsonReportText } from '../report/json.ts';
import { sarifReportText } from '../report/sarif.ts';
import { summaryMarkdown } from '../report/summary-md.ts';
import { plainStyle, printable, printableLines, textReport } from '../report/text.ts';
import { VERSION } from '../version.ts';

export const EXIT = { ok: 0, findings: 1, usage: 2, internal: 3 } as const;

export interface Output {
  write(text: string): unknown;
}

export interface CliIO {
  argv: readonly string[];
  cwd: string;
  stdout: Output;
  stderr: Output;
  /** The real stdout stream, which decides whether the text report is colored. */
  stdoutStream?: NodeJS.WritableStream;
  bundled: BundledData;
  fetch?: typeof fetch;
  /** Overrides the remote registry URL (tests). */
  remoteUrl?: string;
}

const FORMATS = ['text', 'json', 'sarif', 'markdown'] as const;
type Format = (typeof FORMATS)[number];

export const USAGE = `Usage: sunset <command> [options]

Catch deprecated and retiring AI model IDs in your code, with dates quoted from each provider's
official page.

Commands:
  scan [path]              Scan a directory (default: the current one)
  registry info            Show which registry would be used, and what's in it
  registry validate [file] Check a models.yaml (default: the bundled registry)

Options for scan:
  -f, --format <format>    text, json, sarif or markdown (default: text)
  -o, --output <file>      Write the report to a file instead of stdout
  -c, --config <file>      Config file (default: .sunset.yml or .sunset.yaml in the scanned directory)
      --registry <mode>    remote, bundled, a path, or an https URL
                           (default: the config file's, or remote)
      --fail-on <level>    error, warning or never (default: the config file's, or error)
      --platforms <list>   Only these platforms, e.g. openai,bedrock
      --legacy             Also report models the provider calls legacy
      --today <date>       Judge dates as of this day (YYYY-MM-DD), to see what is coming
      --no-color           Don't color the text report
      --debug              Log more detail

Options for registry info: -f/--format text or json, and -c, --registry, --today and --debug
as for scan.

  -h, --help               Show this help
  -v, --version            Show the version

Exit codes: 0 no findings at or above --fail-on, 1 findings at or above it,
2 a usage or config error, 3 an internal error.
Paths in reports are relative to the repository's root when the scanned directory is in a git
work tree, and to the scanned directory otherwise.
Docs: https://github.com/AppliedBenchmark/sunset#readme`;

class UsageError extends Error {
  override name = 'UsageError';
}

const COMMON = {
  config: { type: 'string', short: 'c' },
  registry: { type: 'string' },
  today: { type: 'string' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const SCAN_OPTIONS = {
  ...COMMON,
  format: { type: 'string', short: 'f' },
  output: { type: 'string', short: 'o' },
  'fail-on': { type: 'string' },
  platforms: { type: 'string' },
  legacy: { type: 'boolean' },
  'no-color': { type: 'boolean' },
} as const;

const INFO_OPTIONS = { ...COMMON, format: { type: 'string', short: 'f' } } as const;

export async function runCli(io: CliIO): Promise<number> {
  const [command, ...rest] = io.argv;
  const debug = rest.includes('--debug');
  try {
    switch (command) {
      case undefined:
        // A usage error: the help goes to stderr, so a script's stdout stays clean.
        io.stderr.write(`${USAGE}\n`);
        return EXIT.usage;
      case '-h':
      case '--help':
      case 'help':
        io.stdout.write(`${USAGE}\n`);
        return EXIT.ok;
      case '-v':
      case '--version':
      case 'version':
        io.stdout.write(`sunset ${VERSION}\n`);
        return EXIT.ok;
      case 'scan':
        return await scanCommand(io, rest);
      case 'registry': {
        const [sub, ...args] = rest;
        if (sub === 'info') return await infoCommand(io, args);
        if (sub === 'validate') return await validateCommand(io, args);
        throw new UsageError(
          sub ? `unknown command "registry ${sub}"` : 'registry needs a command: info or validate',
        );
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    // Messages quote the scanned repository's config, file names and the registry, so they are
    // made printable like the report.
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr.write(
        `sunset: ${printableLines((error as Error).message)}\nRun "sunset --help" for usage.\n`,
      );
      return EXIT.usage;
    }
    if (error instanceof ConfigError) {
      io.stderr.write(`sunset: ${printableLines(error.message)}\n`);
      return EXIT.usage;
    }
    const message =
      error instanceof Error ? (debug && error.stack) || error.message : String(error);
    io.stderr.write(`sunset: internal error: ${printableLines(message)}\n`);
    return EXIT.internal;
  }
}

const isParseArgsError = (error: unknown): boolean =>
  typeof (error as { code?: unknown })?.code === 'string' &&
  (error as { code: string }).code.startsWith('ERR_PARSE_ARGS_');

function stderrLogger(io: CliIO, debug: boolean): Logger {
  return {
    info: (m) => io.stderr.write(`sunset: ${printable(m)}\n`),
    warn: (m) => io.stderr.write(`sunset: warning: ${printable(m)}\n`),
    debug: (m) => {
      if (debug) io.stderr.write(`sunset: debug: ${printable(m)}\n`);
    },
  };
}

function clockFrom(today: string | undefined): Clock {
  if (today === undefined) return systemClock;
  try {
    return fixedClock(today);
  } catch {
    throw new UsageError(`--today must be a date (YYYY-MM-DD), got "${today}"`);
  }
}

function formatFrom(value: string | undefined, allowed: readonly string[]): string {
  const format = value ?? 'text';
  if (!allowed.includes(format)) {
    throw new UsageError(`--format must be one of ${allowed.join(', ')}, got "${format}"`);
  }
  return format;
}

function overridesFrom(values: {
  registry?: string | undefined;
  'fail-on'?: string | undefined;
  platforms?: string | undefined;
  legacy?: boolean | undefined;
}): Overrides {
  return {
    ...(values.registry !== undefined && {
      registry: parseRegistryMode(values.registry),
    }),
    ...(values['fail-on'] !== undefined && { failOn: parseFailOn(values['fail-on']) }),
    ...(values.platforms !== undefined && { platforms: parsePlatforms(values.platforms) }),
    ...(values.legacy && { legacy: true }),
  };
}

/** A `--registry` path given on the command line is relative to the working directory. */
function resolveRegistryPath(overrides: Overrides, cwd: string): Overrides {
  const mode = overrides.registry;
  if (mode?.kind !== 'file') return overrides;
  return { ...overrides, registry: { kind: 'file', path: resolve(cwd, mode.path) } };
}

async function scanCommand(io: CliIO, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: SCAN_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  if (positionals.length > 1) throw new UsageError('scan takes one path');
  const format = formatFrom(values.format, FORMATS) as Format;
  const root = resolve(io.cwd, positionals[0] ?? '.');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new UsageError(`${positionals[0] ?? root} is not a directory`);
  }
  const logger = stderrLogger(io, values.debug ?? false);
  const overrides = resolveRegistryPath(overridesFrom(values), io.cwd);

  const output = values.output === undefined ? null : resolve(io.cwd, values.output);
  if (output !== null && existsSync(output) && statSync(output).isDirectory()) {
    throw new UsageError(`--output ${values.output} is a directory`);
  }
  const run = await runScan({
    root,
    configPath: values.config === undefined ? null : resolve(io.cwd, values.config),
    ...(output && { outputs: [output] }),
    overrides,
    bundled: io.bundled,
    http: () => createHttpClient(io.fetch),
    clock: clockFrom(values.today),
    logger,
    ...(io.remoteUrl && { remoteUrl: io.remoteUrl }),
  });
  const ctx = reportContext(run);
  const toFile = values.output !== undefined;
  const git = createGit(root, { maxFileSize: run.settings.maxFileSize });
  const result = rebaseResult(run.result, await repositoryPrefix(git, root));

  let report: string;
  switch (format) {
    case 'text':
      report = textReport(result, ctx, {
        style:
          toFile || !io.stdoutStream
            ? plainStyle
            : terminalStyle(io.stdoutStream, !values['no-color']),
      });
      break;
    case 'json':
      report = jsonReportText(result, ctx);
      break;
    case 'sarif':
      report = sarifReportText(result, ctx);
      break;
    case 'markdown':
      report = summaryMarkdown(result, ctx);
      break;
  }

  if (output !== null) {
    try {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, report);
    } catch (error) {
      throw new UsageError(
        `can't write the report to ${values.output}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      );
    }
    logger.info(`wrote the ${format} report to ${values.output}`);
  } else {
    io.stdout.write(report);
  }

  const failing = failingFindings(run.result, run.settings.failOn);
  if (failing > 0) {
    logger.info(`${plural(failing, 'finding')} at or above fail-on (${run.settings.failOn})`);
    return EXIT.findings;
  }
  return EXIT.ok;
}

async function infoCommand(io: CliIO, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: INFO_OPTIONS, strict: true });
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  const format = formatFrom(values.format, ['text', 'json']);
  const logger = stderrLogger(io, values.debug ?? false);
  const config = await loadConfigFile(
    io.cwd,
    values.config === undefined ? null : resolve(io.cwd, values.config),
  );
  const settings = resolveSettings(
    config.config,
    resolveRegistryPath(overridesFrom({ registry: values.registry }), io.cwd),
  );
  const loaded = await createRegistrySource({
    mode: settings.registry,
    bundled: io.bundled,
    http: () => createHttpClient(io.fetch),
    logger,
    ...(io.remoteUrl && { remoteUrl: io.remoteUrl }),
  }).load();
  const today = clockFrom(values.today).today();
  const { registry } = loaded;
  const newest = registry.models.reduce<IsoDate | null>(
    (max, e) => (max === null || e.verified_on > max ? e.verified_on : max),
    null,
  );
  const tally = (key: 'platform' | 'status') => {
    const counts = new Map<string, number>();
    for (const e of registry.models) counts.set(e[key], (counts.get(e[key]) ?? 0) + 1);
    return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  const info = {
    origin: loaded.origin,
    registry_version: registry.registry_version,
    schema_version: registry.schema_version,
    generated_at: registry.generated_at,
    entries: registry.models.length,
    newest_check: newest,
    newest_check_age_days: newest === null ? null : daysBetween(newest, today),
    platforms: tally('platform'),
    statuses: tally('status'),
    warnings: loaded.warnings,
  };
  if (format === 'json') {
    io.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return EXIT.ok;
  }
  const list = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  io.stdout.write(
    [
      `origin:        ${info.origin}`,
      `version:       v${info.registry_version} (schema ${info.schema_version}), generated ${info.generated_at}`,
      `entries:       ${info.entries.toLocaleString('en-US')}`,
      `newest check:  ${newest ?? 'none'}${info.newest_check_age_days === null ? '' : ` (${age(info.newest_check_age_days)})`}`,
      `platforms:     ${list(info.platforms)}`,
      `statuses:      ${list(info.statuses)}`,
      '',
    ].join('\n'),
  );
  return EXIT.ok;
}

const age = (days: number): string =>
  days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days.toLocaleString('en-US')} days ago`;

async function validateCommand(io: CliIO, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { today: COMMON.today, help: COMMON.help },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  if (positionals.length > 1) throw new UsageError('registry validate takes one file');
  const today = clockFrom(values.today).today();
  const file = positionals[0] === undefined ? null : resolve(io.cwd, positionals[0]);

  let issues: (RegistryIssue & { file?: string })[];
  let entries = 0;
  const label = file ?? 'the bundled registry';
  const dir = file ? dirname(file) : null;
  if (
    file &&
    dir &&
    basename(file) === 'models.yaml' &&
    existsSync(resolve(dir, 'sources.yaml')) &&
    existsSync(resolve(dir, 'formats.yaml'))
  ) {
    // A registry directory: also check sources, snapshots and excerpts.
    const report = await validateRegistryDir(dir, today);
    issues = report.issues;
    entries = report.registry?.models.length ?? 0;
  } else {
    let text: string;
    try {
      text = file ? await readFile(file, 'utf8') : io.bundled.models;
    } catch (error) {
      throw new UsageError(`can't read ${file}: ${(error as NodeJS.ErrnoException).code}`);
    }
    let data: unknown;
    try {
      data = parse(text, QUIET);
    } catch (error) {
      const message = (error as Error).message.split('\n')[0] as string;
      io.stdout.write(`error   ${printable(`${label}: not valid YAML: ${message}`)}\n`);
      return EXIT.findings;
    }
    const checked = validateRegistry(data, { today });
    issues = checked.issues;
    entries = checked.value?.models.length ?? 0;
    // parseRegistry adds the schema_version check that scans apply.
    const usable = parseRegistry(text);
    if ('problem' in usable && checked.value) {
      issues.push({ level: 'error', subject: null, message: usable.problem });
    }
  }

  // Issues quote the file: IDs, aliases, the YAML parser's messages.
  for (const issue of issues) {
    const where = [issue.file, issue.subject].filter(Boolean).join(' ');
    io.stdout.write(
      `${issue.level.padEnd(7)} ${printable(`${where ? `${where}: ` : ''}${issue.message}`)}\n`,
    );
  }
  const errors = issues.filter((i) => i.level === 'error').length;
  io.stdout.write(
    `${printable(label)}: ${plural(entries, 'entry', 'entries')}; ${plural(errors, 'error')}, ${plural(issues.length - errors, 'warning')}\n`,
  );
  return errors > 0 ? EXIT.findings : EXIT.ok;
}
