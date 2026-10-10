// Shared test helpers: the test-only registry, the real ID-format data, and scanning
// in-memory files.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { fixedClock } from '../src/adapters/clock.ts';
import { type ScanOptions, scan } from '../src/core/pipeline.ts';
import type { FileSource } from '../src/core/ports.ts';
import type { PlatformFormats, Registry, ScanResult } from '../src/core/types.ts';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** The date every fixture is written against. */
export const FIXTURE_TODAY = '2099-01-01';

export const fixtureRegistry: Registry = parse(
  readFileSync(new URL('./fixtures/registry/models.yaml', import.meta.url), 'utf8'),
) as Registry;

export const formats: PlatformFormats = parse(
  readFileSync(new URL('../registry/formats.yaml', import.meta.url), 'utf8'),
) as PlatformFormats;

/** A FileSource over an in-memory map of path → text. */
export function memoryFiles(files: Record<string, string>): FileSource {
  return {
    async *list() {
      for (const path of Object.keys(files).sort()) {
        yield { path, size: (files[path] as string).length };
      }
    },
    read: async (file) => files[file.path] ?? null,
  };
}

export function scanFiles(
  files: Record<string, string>,
  opts: Partial<ScanOptions> = {},
): Promise<ScanResult> {
  return scan({
    root: '.',
    files: memoryFiles(files),
    registry: fixtureRegistry,
    formats,
    clock: fixedClock(FIXTURE_TODAY),
    ...opts,
  });
}

/** Scans one file and returns its findings as `rule severity line:col modelId`. */
export async function brief(path: string, text: string, opts: Partial<ScanOptions> = {}) {
  const result = await scanFiles({ [path]: text }, opts);
  return {
    findings: result.findings.map(
      (f) => `${f.rule} ${f.severity} ${f.location.line}:${f.location.column} ${f.modelId}`,
    ),
    unresolved: result.unresolved.map(
      (u) => `${u.reason} ${u.location.line}:${u.location.column} ${u.key} = ${u.expression}`,
    ),
    mentions: result.mentions.map((m) => `${m.location.line}:${m.location.column} ${m.modelId}`),
    inventory: result.inventory.map((i) => i.modelId),
    diagnostics: result.diagnostics.map((d) => `${d.kind} ${d.location?.line ?? '-'}`),
    suppressed: result.suppressed.map((s) => `${s.by} ${s.location.line} ${s.modelId}`),
    result,
  };
}

/** The test-only registry and the real formats, in the shape the entry points bundle them. */
export const bundledFixture = {
  models: readFileSync(new URL('./fixtures/registry/models.yaml', import.meta.url), 'utf8'),
  formats: readFileSync(new URL('../registry/formats.yaml', import.meta.url), 'utf8'),
};
