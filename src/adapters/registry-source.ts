// Registry loading.
//
//   remote   fetch registry/models.yaml from main (3 s timeout, size cap), parse, validate, and fall
//            back to the bundled copy on any failure
//   bundled  the copy built into this release; no network calls, and no HTTP client is created
//   <url>    a mirror, fetched like remote and with the same fallback
//   <path>   a local file, for air-gapped use; a missing or invalid file is a config error
//
// A registry from outside the release (remote, a mirror or a file) is untrusted input. It is
// parsed within limits on bytes and YAML tokens, with no aliases and no quadratic duplicate-key
// check, and it is read forward-compatibly (see core/registry/compat.ts): entries this version
// can't read are left out. A fetched registry (remote or a mirror) then gets the bundled copy's
// entry for every ID it lacks, and isn't used when it is older than the bundled copy; a file is
// used as it is. The schema and semantic checks run before anything is used, and a problem with
// the file as a whole, such as a duplicate id, means it isn't used at all.
import { readFile } from 'node:fs/promises';
import { Lexer, parse } from 'yaml';
import { ConfigError, type RegistryMode } from '../core/config.ts';
import type { LoadedRegistry, Logger, RegistrySource } from '../core/ports.ts';
import { readablePart, type SkippedEntry, withBundled } from '../core/registry/compat.ts';
import { validateFormats, validateRegistry } from '../core/registry/validate.ts';
import type { PlatformFormats, Registry, RegistryEntry } from '../core/types.ts';
import type { HttpClient } from './http.ts';
import { QUIET } from './yaml-options.ts';

export const REMOTE_REGISTRY_URL =
  'https://raw.githubusercontent.com/AppliedBenchmark/sunset/main/registry/models.yaml';
export const REMOTE_TIMEOUT_MS = 3000;
/** Far above the registry's size (about 0.4 MB in October 2026), far below anything harmful. */
export const REMOTE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * A YAML document's parse time and memory follow its node count rather than its size, so an
 * external registry may have at most this many tokens: about 12 times the registry of October
 * 2026, and about a second and 500 MB to parse at worst.
 */
export const MAX_YAML_TOKENS = 1_000_000;
/** The registry schema_version this release reads ("Changing the format" in docs/registry.md). */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** The registry data built into the bundle. */
export interface BundledData {
  models: string;
  formats: string;
}

export interface RegistrySourceOptions {
  mode: RegistryMode;
  bundled: BundledData;
  /** Called only when the mode needs the network. */
  http: () => HttpClient;
  logger: Logger;
  remoteUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ParseOptions {
  /** The registry comes from outside this release: parse it within limits, forward-compatibly. */
  external?: boolean;
  /** With `external`: the entries to keep for the IDs the registry lacks once read. */
  bundled?: readonly RegistryEntry[];
}

export interface ParsedRegistry {
  registry: Registry;
  /** Entries left out because this version can't read them. */
  skipped: SkippedEntry[];
  /** Entries of `bundled` the registry got because it lacked their IDs. */
  kept: RegistryEntry[];
}

/** Parses and checks a registry. Returns it, or the reason it can't be used. */
export function parseRegistry(
  text: string,
  opts: ParseOptions = {},
): ParsedRegistry | { problem: string } {
  if (opts.external && tokenCountExceeds(text, MAX_YAML_TOKENS)) {
    return { problem: `more than ${MAX_YAML_TOKENS.toLocaleString('en-US')} YAML tokens` };
  }
  let data: unknown;
  try {
    // The registry uses no aliases, and checking for duplicate keys is quadratic in a mapping's size.
    data = parse(text, opts.external ? { ...QUIET, uniqueKeys: false, maxAliasCount: 0 } : QUIET);
  } catch (error) {
    return { problem: `not valid YAML: ${firstLine(error)}` };
  }
  const version = (data as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version === 'number' && version !== SUPPORTED_SCHEMA_VERSION) {
    return {
      problem: `schema_version ${version} isn't supported by this version of Sunset (it reads ${SUPPORTED_SCHEMA_VERSION}); update Sunset`,
    };
  }
  const readable = opts.external ? readablePart(data) : { data, skipped: [] };
  const merged =
    opts.external && opts.bundled
      ? withBundled(readable.data, opts.bundled)
      : { data: readable.data, kept: [] };
  const { value, issues } = validateRegistry(merged.data);
  if (!value) {
    const errors = issues.filter((i) => i.level === 'error');
    const first = errors[0];
    const more =
      errors.length > 1 ? ` (and ${(errors.length - 1).toLocaleString('en-US')} more)` : '';
    return {
      problem: `invalid: ${first?.subject ? `${first.subject}: ` : ''}${first?.message}${more}`,
    };
  }
  return { registry: value, skipped: readable.skipped, kept: merged.kept };
}

function tokenCountExceeds(text: string, max: number): boolean {
  const tokens = new Lexer().lex(text);
  for (let count = 0; !tokens.next().done; ) if (++count > max) return true;
  return false;
}

/** The bundled formats data; a problem with it is a bug in the release. */
export function bundledFormats(bundled: BundledData): PlatformFormats {
  const { value, issues } = validateFormats(parse(bundled.formats));
  if (!value) throw new Error(`the bundled formats.yaml is invalid: ${issues[0]?.message}`);
  return value;
}

export function createRegistrySource(opts: RegistrySourceOptions): RegistrySource {
  const loaded = (registry: Registry, origin: LoadedRegistry['origin'], warnings: string[]) => ({
    registry,
    origin,
    version: registry.registry_version ?? null,
    warnings,
  });

  let bundledCopy: Registry | null = null;
  const bundledRegistry = (): Registry => {
    if (!bundledCopy) {
      const result = parseRegistry(opts.bundled.models);
      if ('problem' in result) throw new Error(`the bundled registry is ${result.problem}`);
      bundledCopy = result.registry;
    }
    return bundledCopy;
  };
  const bundled = (warnings: string[]): LoadedRegistry =>
    loaded(bundledRegistry(), 'bundled', warnings);

  const entries = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'entry' : 'entries'}`;
  const noteUnread = ({ skipped, kept }: ParsedRegistry, label: string) => {
    const notes: string[] = [];
    if (skipped.length > 0) {
      notes.push(
        `The ${label} registry has ${entries(skipped.length)} that this version of Sunset can't read; update Sunset to check them.`,
      );
    }
    if (kept.length > 0) {
      const one = kept.length === 1;
      notes.push(
        skipped.length > 0
          ? `${entries(kept.length)} ${one ? 'comes' : 'come'} from the bundled copy instead.`
          : `The ${label} registry lacks ${entries(kept.length)} of the bundled copy, which ${one ? 'is' : 'are'} kept.`,
      );
    }
    if (notes.length > 0) opts.logger.info(notes.join(' '));
    for (const { entry, reason } of skipped) opts.logger.debug(`left out ${entry}: ${reason}`);
    for (const { id } of kept) opts.logger.debug(`kept ${id} from the bundled copy`);
  };

  const fetchOrFallBack = async (url: string, label: string): Promise<LoadedRegistry> => {
    // A fetched registry never knows less than the release: it gets the bundled entries it lacks,
    // and one older than the bundled copy, such as a stale mirror, isn't used.
    const own = bundledRegistry();
    let problem: string;
    try {
      const text = await opts.http().getText(url, {
        timeoutMs: opts.timeoutMs ?? REMOTE_TIMEOUT_MS,
        maxBytes: opts.maxBytes ?? REMOTE_MAX_BYTES,
      });
      const result = parseRegistry(text, { external: true, bundled: own.models });
      if ('registry' in result) {
        // The schema requires `registry_version`, so both copies have one.
        const version = result.registry.registry_version;
        if (version < own.registry_version) {
          const warning = `The ${label} registry is v${version}, older than the bundled copy (v${own.registry_version}); using the bundled copy.`;
          opts.logger.warn(warning);
          return bundled([warning]);
        }
        noteUnread(result, label);
        return loaded(result.registry, 'remote', []);
      }
      problem = result.problem;
    } catch (error) {
      problem = firstLine(error);
    }
    const warning = `Couldn't use the ${label} registry (${problem}); using the bundled copy.`;
    opts.logger.warn(warning);
    return bundled([warning]);
  };

  return {
    async load() {
      const mode = opts.mode;
      switch (mode.kind) {
        case 'bundled':
          return bundled([]);
        case 'remote':
          return fetchOrFallBack(opts.remoteUrl ?? REMOTE_REGISTRY_URL, 'remote');
        case 'url':
          return fetchOrFallBack(mode.url, `mirror ${mode.url}`);
        case 'file': {
          let text: string;
          try {
            text = await readFile(mode.path, 'utf8');
          } catch (error) {
            throw new ConfigError(`registry: can't read ${mode.path}: ${firstLine(error)}`);
          }
          const result = parseRegistry(text, { external: true });
          if ('problem' in result) {
            throw new ConfigError(`registry: ${mode.path} is ${result.problem}`);
          }
          // A file is used as given, without the bundled entries, so what it can't give is a
          // warning, and a file that gives nothing at all is an error.
          const { skipped } = result;
          if (skipped.length === 0) return loaded(result.registry, 'file', []);
          if (result.registry.models.length === 0) {
            throw new ConfigError(
              `registry: this version of Sunset can't read any of the ${entries(skipped.length)} in ${mode.path}; update Sunset`,
            );
          }
          const warning = `The ${mode.path} registry has ${entries(skipped.length)} that this version of Sunset can't read; update Sunset to check them.`;
          opts.logger.warn(warning);
          for (const { entry, reason } of skipped)
            opts.logger.debug(`left out ${entry}: ${reason}`);
          return loaded(result.registry, 'file', [warning]);
        }
      }
    },
  };
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}
