// Configuration: validating `.sunset.yml`, and merging it with the defaults and with
// CLI flags or Action inputs. Flags and inputs override the file, which overrides the defaults.
// Pure: the adapters read the file and resolve relative paths.
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import schema from '../../docs/schemas/config.schema.json' with { type: 'json' };
import { parseIsoDate } from './dates.ts';
import { DEFAULT_MAX_FILE_SIZE } from './pipeline.ts';
import { DEFAULT_DIRECTIVE_PREFIX, type IgnoreRule } from './scan/suppress.ts';
import { compareSeverity } from './severity.ts';
import type { IsoDate, Platform, RuleId, ScanResult, Severity } from './types.ts';

/** A problem with the configuration, a flag or an input. The CLI exits with 2. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type FailOn = 'error' | 'warning' | 'never';
export type FailScope = 'all' | 'new';

export type RegistryMode =
  | { kind: 'remote' }
  | { kind: 'bundled' }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string };

/** `.sunset.yml` as written; see docs/schemas/config.schema.json. */
export interface ConfigFile {
  include?: string[];
  exclude?: string[];
  docs?: string[];
  ignore?: {
    paths?: string[];
    models?: string[];
    rules?: string[];
    until?: string;
    reason?: string;
  }[];
  legacy?: boolean;
  'fail-on'?: FailOn;
  'fail-scope'?: FailScope;
  registry?: string;
  'max-file-size'?: number;
  platforms?: Platform[];
}

/** What flags and inputs can set. Unset values fall through to the file and the defaults. */
export interface Overrides {
  failOn?: FailOn;
  failScope?: FailScope;
  registry?: RegistryMode;
  platforms?: Platform[];
  legacy?: boolean;
}

export interface Settings {
  include: string[];
  exclude: string[];
  docs: string[];
  ignore: IgnoreRule[];
  legacy: boolean;
  failOn: FailOn;
  /** On pull requests: fail on every finding, or only on those the pull request adds. */
  failScope: FailScope;
  registry: RegistryMode;
  maxFileSize: number;
  /** Null: every platform. */
  platforms: Platform[] | null;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  include: [],
  exclude: [],
  docs: [],
  ignore: [],
  legacy: false,
  failOn: 'error',
  failScope: 'all',
  registry: { kind: 'remote' },
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
  platforms: null,
};

export const PLATFORMS: readonly Platform[] = schema.$defs.Platform.enum as Platform[];
export const FAIL_ON: readonly FailOn[] = ['error', 'warning', 'never'];
export const FAIL_SCOPE: readonly FailScope[] = ['all', 'new'];

let validator: ReturnType<Ajv2020['compile']> | null = null;
const DATE_SHAPE = new RegExp(schema.$defs.IgnoreRule.properties.until.pattern);

/** Checks a parsed `.sunset.yml`; throws a ConfigError that lists every problem. */
export function validateConfig(data: unknown, file = '.sunset.yml'): ConfigFile {
  // An empty file parses as null: no settings.
  if (data === null || data === undefined) return {};
  validator ??= new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(
    schema,
  );
  const problems = validator(data) ? [] : describe(validator.errors ?? []);
  // Dates the schema's pattern lets through but the calendar doesn't have, such as 2027-02-30.
  const ignore = (data as { ignore?: unknown }).ignore;
  for (const [i, rule] of (Array.isArray(ignore) ? ignore : []).entries()) {
    const until = (rule as { until?: unknown } | null)?.until;
    if (typeof until === 'string' && DATE_SHAPE.test(until) && parseIsoDate(until) === null) {
      problems.push(`ignore[${i}].until: "${until}" is not a valid date (YYYY-MM-DD)`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`${file} is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return data as ConfigFile;
}

function describe(errors: readonly ErrorObject[]): string[] {
  const out = new Set<string>();
  for (const e of errors) {
    // anyOf repeats the branch errors; one line saying what's missing is enough.
    if (e.keyword === 'required' && e.schemaPath.includes('anyOf')) continue;
    const where = e.instancePath
      .replace(/^\//, '')
      .replace(/\/(\d+)/g, '[$1]')
      .replace(/\//g, '.');
    const subject = where || 'the file';
    if (e.keyword === 'additionalProperties') {
      out.add(`${subject}: unknown key ${JSON.stringify(e.params.additionalProperty)}`);
    } else if (e.keyword === 'enum') {
      const allowed = (e.params.allowedValues as unknown[]).filter(
        (v) => !String(v).startsWith(`${DEFAULT_DIRECTIVE_PREFIX}/`),
      );
      out.add(`${subject}: must be one of ${allowed.join(', ')}`);
    } else if (e.keyword === 'anyOf') {
      out.add(`${subject}: needs at least one of paths, models or rules`);
    } else {
      out.add(`${subject}: ${e.message}`);
    }
  }
  return [...out];
}

/** `--registry` / `registry:` values: remote, bundled, an https URL (http only on loopback), or a path. */
export function parseRegistryMode(text: string): RegistryMode {
  const value = text.trim();
  if (value === 'remote' || value === 'bundled') return { kind: value };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ConfigError(`registry: "${value}" is not a valid URL`);
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new ConfigError(`registry: mirrors must use https, got ${url.protocol}`);
    }
    return { kind: 'url', url: url.href };
  }
  if (value === '') throw new ConfigError('registry: must not be empty');
  return { kind: 'file', path: value };
}

export function parseFailOn(text: string): FailOn {
  const value = text.trim();
  if (!(FAIL_ON as readonly string[]).includes(value)) {
    throw new ConfigError(`fail-on: must be one of ${FAIL_ON.join(', ')}, got "${value}"`);
  }
  return value as FailOn;
}

export function parseFailScope(text: string): FailScope {
  const value = text.trim();
  if (!(FAIL_SCOPE as readonly string[]).includes(value)) {
    throw new ConfigError(`fail-scope: must be one of ${FAIL_SCOPE.join(', ')}, got "${value}"`);
  }
  return value as FailScope;
}

/** A comma- or whitespace-separated platform list. */
export function parsePlatforms(text: string): Platform[] {
  const names = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  const unknown = names.filter((n) => !(PLATFORMS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new ConfigError(
      `platforms: unknown platform ${unknown.map((n) => `"${n}"`).join(', ')}; use ${PLATFORMS.join(', ')}`,
    );
  }
  if (names.length === 0) throw new ConfigError('platforms: name at least one platform');
  return names as Platform[];
}

const stripPrefix = (rule: string): RuleId =>
  rule.replace(new RegExp(`^${DEFAULT_DIRECTIVE_PREFIX}/`), '') as RuleId;

/**
 * The globs, each also matching what is under it, so that a directory's name (`legacy`, or
 * `legacy/`) matches the files in it, as in .gitignore. In picomatch it would match nothing.
 */
function withContents(globs: readonly string[]): string[] {
  return globs.flatMap((glob) =>
    glob.startsWith('!') || glob.endsWith('/**')
      ? [glob]
      : [glob, `${glob.replace(/\/+$/, '')}/**`],
  );
}

/** Defaults, then the file, then the overrides. */
export function resolveSettings(file: ConfigFile | null, overrides: Overrides = {}): Settings {
  const f = file ?? {};
  return {
    include: withContents(f.include ?? DEFAULT_SETTINGS.include),
    exclude: withContents(f.exclude ?? DEFAULT_SETTINGS.exclude),
    docs: withContents(f.docs ?? DEFAULT_SETTINGS.docs),
    ignore: (f.ignore ?? []).map((rule) => ({
      ...(rule.paths && { paths: withContents(rule.paths) }),
      ...(rule.models && { models: rule.models }),
      ...(rule.rules && { rules: [...new Set(rule.rules.map(stripPrefix))] }),
      ...(rule.until !== undefined && { until: rule.until as IsoDate }),
      ...(rule.reason !== undefined && { reason: rule.reason }),
    })),
    legacy: overrides.legacy ?? f.legacy ?? DEFAULT_SETTINGS.legacy,
    failOn: overrides.failOn ?? f['fail-on'] ?? DEFAULT_SETTINGS.failOn,
    failScope: overrides.failScope ?? f['fail-scope'] ?? DEFAULT_SETTINGS.failScope,
    registry:
      overrides.registry ??
      (f.registry === undefined ? DEFAULT_SETTINGS.registry : parseRegistryMode(f.registry)),
    maxFileSize: f['max-file-size'] ?? DEFAULT_SETTINGS.maxFileSize,
    platforms: overrides.platforms ?? f.platforms ?? DEFAULT_SETTINGS.platforms,
  };
}

/** Findings at or above `failOn`. Docs mentions, unresolved references and suppressed findings never count. */
export function failingFindings(result: Pick<ScanResult, 'findings'>, failOn: FailOn): number {
  return atOrAbove(result.findings, failOn).length;
}

/** The findings at or above `failOn`; none for `never`. */
export function atOrAbove<T extends { severity: Severity }>(
  findings: readonly T[],
  failOn: FailOn,
): T[] {
  if (failOn === 'never') return [];
  return findings.filter((f) => compareSeverity(f.severity, failOn) <= 0);
}
