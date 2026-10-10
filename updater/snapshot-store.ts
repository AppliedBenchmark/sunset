// registry/snapshots/<provider>/<slug>.txt and .meta.json. A snapshot whose
// normalized text and markup state are unchanged is left alone, so its .meta.json (and fetch
// time) only changes when the page does.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FetchedPage } from '../src/core/ports.ts';
import type { NormalizedPage } from '../src/core/registry/extract.ts';
import { NORMALIZER_VERSION } from '../src/core/registry/normalize.ts';

export interface SnapshotMeta {
  source: string;
  /** The URLs fetched, after redirects. */
  urls: string[];
  fetched_at: string;
  etag: string | null;
  last_modified: string | null;
  /** SHA-256 of the normalized text. */
  sha256: string;
  normalizer_version: number;
  /** Row state from the source's markup page; only for sources with `markup`. */
  row_classes?: Record<string, string[]>;
}

export interface Snapshot {
  page: NormalizedPage;
  meta: SnapshotMeta;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** biome.json's `formatter.lineWidth`. */
const LINE_WIDTH = 100;
// A JSON.stringify array of strings: its key line, its items, its closing bracket.
const STRING_ARRAY = /^( *)("[^"\n]*": )\[\n((?: *"(?:[^"\\\n]|\\.)*",?\n)+) *\]/gm;

/**
 * The text of a `.meta.json` file, laid out the way Biome formats JSON, so that a pull request
 * from the updater passes `biome ci`: JSON.stringify with two-space indents, except that an array
 * of strings goes on one line when that line, with the comma after it, fits in LINE_WIDTH.
 */
export function formatMeta(meta: SnapshotMeta): string {
  const text = JSON.stringify(meta, null, 2).replace(
    STRING_ARRAY,
    (whole, indent: string, key: string, items: string, offset: number, all: string) => {
      const values = items.split('\n').flatMap((line) => line.trim().replace(/,$/, '') || []);
      const line = `${indent}${key}[${values.join(', ')}]`;
      const comma = all[offset + whole.length] === ',' ? 1 : 0;
      return line.length + comma <= LINE_WIDTH ? line : whole;
    },
  );
  return `${text}\n`;
}

export class SnapshotStore {
  readonly registryDir: string;

  constructor(registryDir: string) {
    this.registryDir = registryDir;
  }

  path(id: string): string {
    return join(this.registryDir, 'snapshots', `${id}.txt`);
  }

  metaPath(id: string): string {
    return join(this.registryDir, 'snapshots', `${id}.meta.json`);
  }

  async read(id: string): Promise<Snapshot | null> {
    let text: string;
    let meta: SnapshotMeta;
    try {
      text = await readFile(this.path(id), 'utf8');
      meta = JSON.parse(await readFile(this.metaPath(id), 'utf8')) as SnapshotMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return { page: { text, row_classes: meta.row_classes ?? {} }, meta };
  }

  /** True when `fetched` differs from the stored snapshot (text, markup state or normalizer). */
  static changed(previous: Snapshot | null, fetched: FetchedPage): boolean {
    if (!previous) return true;
    return (
      previous.meta.sha256 !== sha256(fetched.text) ||
      previous.meta.normalizer_version !== NORMALIZER_VERSION ||
      JSON.stringify(previous.meta.row_classes ?? {}) !== JSON.stringify(fetched.row_classes)
    );
  }

  async write(id: string, fetched: FetchedPage, now: Date): Promise<Snapshot> {
    const meta: SnapshotMeta = {
      source: id,
      urls: fetched.urls,
      fetched_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
      etag: fetched.etag,
      last_modified: fetched.last_modified,
      sha256: sha256(fetched.text),
      normalizer_version: NORMALIZER_VERSION,
      ...(Object.keys(fetched.row_classes).length ? { row_classes: fetched.row_classes } : {}),
    };
    await mkdir(dirname(this.path(id)), { recursive: true });
    await writeFile(this.path(id), fetched.text);
    await writeFile(this.metaPath(id), formatMeta(meta));
    return { page: { text: fetched.text, row_classes: fetched.row_classes }, meta };
  }
}
