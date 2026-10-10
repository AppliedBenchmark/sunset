// Reads the registry directory: models.yaml, sources.yaml, formats.yaml and the snapshots, then
// validates them with the pure validator. Used by `npm run registry:validate` and
// `sunset registry validate`.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  type RegistryIssue,
  validateFormats,
  validatePageFacts,
  validateRegistry,
  validateSources,
} from '../core/registry/validate.ts';
import type { IsoDate, PlatformFormats, Registry, SourcesFile } from '../core/types.ts';
import { QUIET } from './yaml-options.ts';

export interface RegistryDirReport {
  registry: Registry | null;
  sources: SourcesFile | null;
  formats: PlatformFormats | null;
  /** Issues prefixed with the file they're in. */
  issues: (RegistryIssue & { file: string })[];
}

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, 'utf8'), QUIET);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Validates `<dir>/models.yaml` against its sources and committed snapshots. */
export async function validateRegistryDir(dir: string, today: IsoDate): Promise<RegistryDirReport> {
  const issues: RegistryDirReport['issues'] = [];
  const add = (file: string, list: RegistryIssue[]) => {
    for (const issue of list) issues.push({ ...issue, file });
  };

  const formats = validateFormats(await readYaml(join(dir, 'formats.yaml')));
  add('formats.yaml', formats.issues);
  const sources = validateSources(await readYaml(join(dir, 'sources.yaml')));
  add('sources.yaml', sources.issues);

  const snapshots = new Map<string, string>();
  for (const source of sources.value?.sources ?? []) {
    const text = await readOptional(join(dir, 'snapshots', `${source.id}.txt`));
    if (text !== undefined) snapshots.set(source.id, text);
  }
  if (sources.value) add('sources.yaml', validatePageFacts(sources.value, snapshots));
  const registry = validateRegistry(await readYaml(join(dir, 'models.yaml')), {
    ...(sources.value ? { sources: sources.value } : {}),
    snapshots,
    today,
  });
  add('models.yaml', registry.issues);
  return {
    registry: registry.value,
    sources: sources.value,
    formats: formats.value,
    issues,
  };
}
