// One configured scan, shared by the CLI and the Action: read the config, merge it with the
// flags or inputs, load the registry, scan, and log what happened. The entry points
// add only their own I/O around it.
import { isAbsolute, relative, sep } from 'node:path';
import { CONFIG_FILE_NAMES, loadConfigFile } from '../adapters/config-file.ts';
import { createFileSource } from '../adapters/file-source.ts';
import type { HttpClient } from '../adapters/http.ts';
import {
  type BundledData,
  bundledFormats,
  createRegistrySource,
} from '../adapters/registry-source.ts';
import { type Overrides, resolveSettings, type Settings } from '../core/config.ts';
import { daysBetween } from '../core/dates.ts';
import { type ScanOptions, scan } from '../core/pipeline.ts';
import {
  type InferredPlatforms,
  inferPlatforms,
  isManifest,
  type Manifest,
} from '../core/platforms.ts';
import type { Clock, FileSource, LoadedRegistry, Logger } from '../core/ports.ts';
import { type ClassifyOptions, createClassifier } from '../core/scan/classify.ts';
import type { Location, Platform, ScanResult } from '../core/types.ts';
import { plural, type ReportContext } from '../report/common.ts';
import { VERSION } from '../version.ts';

/**
 * Warn when the registry's newest check is older than this: a bundled copy ages with its release,
 * and a registry nobody maintains stops changing.
 */
export const STALE_REGISTRY_DAYS = 30;

export interface ScanRequest {
  /** The directory to scan. */
  root: string;
  /** An explicit config file; without one, `.sunset.yml` in `root` is used if it exists. */
  configPath: string | null;
  overrides: Overrides;
  bundled: BundledData;
  /** Created only when the registry mode needs the network. */
  http: () => HttpClient;
  /** Files this run writes (reports): a report from an earlier run is never scanned. */
  outputs?: readonly string[];
  clock: Clock;
  logger: Logger;
  remoteUrl?: string;
  files?: FileSource;
}

export interface ScanRun {
  settings: Settings;
  configPath: string | null;
  registry: LoadedRegistry;
  result: ScanResult;
  /** The options the scan ran with, for scanning another revision the same way. */
  options: ScanOptions;
}

export async function runScan(req: ScanRequest): Promise<ScanRun> {
  const { logger } = req;
  const config = await loadConfigFile(req.root, req.configPath);
  if (config.path) logger.info(`config: ${config.path}`);
  const settings = resolveSettings(config.config, req.overrides);
  logger.debug(`settings: ${JSON.stringify(settings)}`);

  const registry = await createRegistrySource({
    mode: settings.registry,
    bundled: req.bundled,
    http: req.http,
    logger,
    ...(req.remoteUrl && { remoteUrl: req.remoteUrl }),
  }).load();

  const files = req.files ?? createFileSource();
  const classify: ClassifyOptions = {
    include: settings.include,
    exclude: [
      ...settings.exclude,
      ...CONFIG_FILE_NAMES.map((name) => `**/${name}`),
      ...exactGlobs(req.root, [...(config.path ? [config.path] : []), ...(req.outputs ?? [])]),
    ],
    overrides: settings.docs.length > 0 ? [{ paths: settings.docs, class: 'docs' }] : [],
  };
  let preferred: Platform[] = [];
  if (!settings.platforms) {
    const inferred = await inferFromManifests(req.root, files, classify);
    preferred = inferred.platforms;
    if (preferred.length > 0) {
      logger.info(
        `platforms: ${preferred.join(', ')}, inferred from ${inferred.evidence.join('; ')}. They settle IDs that several platforms serve; set \`platforms\` to override.`,
      );
    }
  }

  const options: ScanOptions = {
    root: req.root,
    files,
    registry: registry.registry,
    formats: bundledFormats(req.bundled),
    clock: req.clock,
    logger,
    classify,
    ignores: settings.ignore,
    legacy: settings.legacy,
    maxFileSize: settings.maxFileSize,
    platforms: settings.platforms,
    preferredPlatforms: preferred,
    now: () => performance.now(),
  };
  const result = await scan(options);
  logRun(result, registry, logger);
  return { settings, configPath: config.path, registry, result, options };
}

/**
 * Globs for files under `root` that are Sunset's own, so the scan leaves them out: the config file
 * in use (its `ignore` rules name model IDs on purpose; every `.sunset.yml` and `.sunset.yaml` is
 * left out too) and the reports this run writes, which an earlier run may have left behind.
 */
function exactGlobs(root: string, paths: readonly string[]): string[] {
  return paths.flatMap((path) => {
    const rel = relative(root, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];
    // Escaped, so the glob matches only this path.
    return [
      rel
        .split(sep)
        .join('/')
        .replace(/[\\*?[\]{}()!+@]/g, '\\$&'),
    ];
  });
}

/** At most this many manifests are read, each up to the size limit. */
const MAX_MANIFESTS = 200;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Reads the dependency manifests the scan would see (not vendored, not excluded). */
async function inferFromManifests(
  root: string,
  files: FileSource,
  classify: ClassifyOptions,
): Promise<InferredPlatforms> {
  const classifier = createClassifier(classify);
  const manifests: Manifest[] = [];
  for await (const ref of files.list(root, { maxFileSize: MAX_MANIFEST_BYTES })) {
    if (manifests.length >= MAX_MANIFESTS) break;
    if (!isManifest(ref.path) || ref.size > MAX_MANIFEST_BYTES) continue;
    const file = classifier.classify(ref);
    if (!file || file.class === 'vendored' || file.class === 'generated') continue;
    const text = await files.read(ref);
    if (text !== null) manifests.push({ path: ref.path, text });
  }
  return inferPlatforms(manifests);
}

const count = (n: number): string => n.toLocaleString('en-US');

function logRun(result: ScanResult, registry: LoadedRegistry, logger: Logger): void {
  const { registryVersion, newestCheck, entries } = result.registry;
  const age = newestCheck === null ? null : daysBetween(newestCheck, result.today);
  logger.info(
    `registry: ${registry.origin} v${registryVersion ?? '?'} (${plural(entries, 'entry', 'entries')}${newestCheck ? `, newest check ${newestCheck}` : ''})`,
  );
  if (age !== null && age > STALE_REGISTRY_DAYS) {
    logger.warn(
      `The registry's newest check is ${count(age)} days old (${newestCheck}). Dates may have changed since; ${
        registry.origin === 'bundled'
          ? 'update Sunset, or let it fetch the latest registry (registry: remote).'
          : 'the registry may no longer be maintained.'
      }`,
    );
  }
  const { files, lines, timings } = result.stats;
  const skipped = Object.entries(files.skipped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${count(n)} ${reason}`)
    .join(', ');
  logger.info(
    `scanned ${count(files.scanned)} of ${plural(files.listed, 'file')} (${count(files.lexed)} lexed${skipped ? `; skipped ${skipped}` : ''}), ${plural(lines, 'line')}, in ${count(Math.round(timings.total))} ms`,
  );
  logger.debug(
    `timings: list ${count(Math.round(timings.list))} ms, scan ${count(Math.round(timings.scan))} ms`,
  );
}

export function reportContext(
  run: Pick<ScanRun, 'registry'>,
  fileUrl?: (location: Location) => string,
): ReportContext {
  return {
    version: VERSION,
    registryOrigin: run.registry.origin,
    ...(fileUrl && { fileUrl }),
  };
}
