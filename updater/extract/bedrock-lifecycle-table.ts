// Parser for Bedrock's model lifecycle pages (`parser: bedrock-lifecycle-table`). The tables have
// the columns `Model provider | Model name | Model ID | Regions | Legacy date | EOL date | Public
// extended access start date`; htmlToText repeats rowspan cells, so every row stands alone. Any
// other table with one of these columns is a problem.
//
// - Every listed model is in the Legacy state or past EOL: the Legacy date is the deprecation
//   date and the EOL date the retirement date (statusFor makes passed dates `retired`).
// - A model listed in several rows (one per group of regions) becomes one entry when the rows
//   agree on the dates, and one region-scoped entry per row when they don't.
// - The maker is the ID's prefix (`anthropic.claude-…` → anthropic).
// - The newer page (models launched on or after 2026-09-07) may have no table yet: a page that
//   still has its "Legacy and end-of-life" section and no table at all lists no models.

import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageDate,
} from '../../src/core/registry/extract.ts';
import { cellText, columns, type TableRow, tables, unreadTables } from './table.ts';

const HEADERS = {
  id: 'Model ID',
  regions: 'Regions',
  legacy: 'Legacy date',
  eol: 'EOL date',
} as const;
const EXTENDED = 'public extended access start date';
const SECTION = /^#+ Legacy and end-of-life \(EOL\) models$/m;

interface Parsed {
  id: string;
  regions: string[];
  legacy: PageDate | null;
  eol: PageDate | null;
  extended: string | null;
  line: string;
}

export const extractor: Extractor = {
  id: 'bedrock-lifecycle-table',
  extract(page) {
    const all = tables(page.text);
    const lifecycle = all.filter((t) => columns(t, HEADERS) !== null);
    const problems = unreadTables(all, (t) => columns(t, HEADERS) !== null, Object.values(HEADERS));
    if (lifecycle.length === 0) {
      if (all.length === 0 && SECTION.test(page.text)) {
        return { rows: [], problems, exhaustive: true };
      }
      throw new LayoutChangedError(
        `no table with the columns ${Object.values(HEADERS).join(', ')}`,
      );
    }

    const date = (row: TableRow, index: number, what: string): PageDate | null | undefined => {
      const text = cellText(row.cells[index] ?? '');
      const parsed = parseDateString(text);
      if (parsed.kind === 'none') return null;
      if (parsed.kind === 'invalid') {
        problems.push(`unrecognized ${what} "${text}" in: ${row.line}`);
        return undefined;
      }
      return { text, iso: parsed.iso };
    };

    const byId = new Map<string, Parsed[]>();
    for (const table of lifecycle) {
      const col = columns(table, HEADERS) as Record<keyof typeof HEADERS, number>;
      const extendedCol = table.headers.findIndex((h) => h.toLowerCase() === EXTENDED);
      if (table.rows.length === 0) throw new LayoutChangedError('a lifecycle table has no rows');
      for (const row of table.rows) {
        const id = cellText(row.cells[col.id] ?? '');
        if (!/^\S+$/.test(id)) {
          problems.push(`unrecognized model ID "${id}" in: ${row.line}`);
          continue;
        }
        const legacy = date(row, col.legacy, 'Legacy date');
        const eol = date(row, col.eol, 'EOL date');
        const extended = extendedCol < 0 ? null : date(row, extendedCol, 'extended access date');
        if (legacy === undefined || eol === undefined || extended === undefined) continue;
        const regions = cellText(row.cells[col.regions] ?? '')
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
          .sort();
        const list = byId.get(id) ?? [];
        list.push({ id, regions, legacy, eol, extended: extended?.iso ?? null, line: row.line });
        byId.set(id, list);
      }
    }

    const rows: ExtractedRow[] = [];
    for (const [id, list] of byId) {
      const key = (p: Parsed) => `${p.legacy?.iso}|${p.eol?.iso}`;
      const agree = list.every((p) => key(p) === key(list[0] as Parsed));
      for (const p of agree ? [list[0] as Parsed] : list) {
        rows.push({
          platform: 'bedrock',
          provider: id.split('.')[0] as string,
          model_id: id,
          version: null,
          regions: agree || p.regions.length === 0 ? null : p.regions,
          state: 'deprecated',
          deprecation: p.legacy,
          retirement: p.eol,
          qualifier: 'exact',
          replacements: [],
          excerpt: p.line,
          notes: p.extended ? `Public extended access starts ${p.extended}.` : null,
        });
      }
    }
    return { rows, problems, exhaustive: true };
  },
};
