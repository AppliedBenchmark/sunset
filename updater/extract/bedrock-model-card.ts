// Parser for Bedrock model cards (`parser: bedrock-model-card`): the lifecycle source for models
// launched on or after 2026-09-07, and for older models that only their card says are Legacy. A
// card lists its lifecycle facts as lines:
//
//   EOL no sooner than: September 22, 2027     the earliest possible EOL (no_earlier_than)
//   Model EOL date: N/A                        set once the model enters its Legacy period
//
// and its IDs in a table with the columns `Endpoint | Model ID | …`, one row per endpoint. The card
// is about one model (the source's `models`), so excerpts needn't repeat its ID. The maker is the
// ID's prefix.
// - Some cards give the model a second ID on another endpoint (`deepseek.v3-v1:0` on
//   bedrock-runtime, `deepseek.v3.1` on bedrock-mantle). The row is for the bedrock-runtime ID and
//   its notes name the other one, which a person adds as an alias: rows can't carry aliases.
// - A cell that isn't a `<maker>.<model>` ID (`N/A`) means the endpoint has none.
// Every card has the `Model EOL date` line; without it (renamed, say), an announced EOL date
// would go unread, so that is a layout change.

import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageDate,
} from '../../src/core/registry/extract.ts';
import { cellText, columns, tables } from './table.ts';

const NO_SOONER = /^EOL (no sooner than:?\s*(.*))$/im;
const EOL_DATE = /^Model EOL date:?\s*(.*)$/im;
const MODEL_ID = /^[a-z0-9-]+\.\S+$/;
const RUNTIME = 'bedrock-runtime';

/**
 * The card's model ID and, when another endpoint calls the model differently, that endpoint and
 * ID; or a problem when the IDs don't fit that shape.
 */
function modelIds(
  text: string,
): { id: string; other: { endpoint: string; id: string } | null } | string {
  const endpoints = new Map<string, string>();
  for (const table of tables(text)) {
    const col = columns(table, { endpoint: 'Endpoint', id: 'Model ID' });
    if (!col) continue;
    for (const row of table.rows) {
      const id = cellText(row.cells[col.id] ?? '');
      if (MODEL_ID.test(id)) endpoints.set(id, cellText(row.cells[col.endpoint] ?? ''));
    }
  }
  if (endpoints.size === 0) throw new LayoutChangedError('no `Endpoint | Model ID` table');
  const ids = [...endpoints.keys()];
  if (ids.length === 1) return { id: ids[0] as string, other: null };
  const runtime = ids.filter((id) => endpoints.get(id) === RUNTIME);
  const others = ids.filter((id) => endpoints.get(id) !== RUNTIME);
  if (ids.length > 2 || runtime.length !== 1 || others.length !== 1) {
    return `the card lists more than one base model ID: ${ids.join(', ')}`;
  }
  const other = others[0] as string;
  return {
    id: runtime[0] as string,
    other: { endpoint: endpoints.get(other) as string, id: other },
  };
}

export const extractor: Extractor = {
  id: 'bedrock-model-card',
  extract(page) {
    const problems: string[] = [];
    const ids = modelIds(page.text);
    if (typeof ids === 'string') return { rows: [], problems: [ids], exhaustive: true };
    const { id, other } = ids;

    const parse = (text: string, line: string): PageDate | null | undefined => {
      const parsed = parseDateString(text);
      if (parsed.kind === 'none') return null;
      if (parsed.kind === 'invalid') {
        problems.push(`unrecognized date "${text}" in: ${line}`);
        return undefined;
      }
      return { text: parsed.date, iso: parsed.iso };
    };

    const noSooner = NO_SOONER.exec(page.text);
    const eol = EOL_DATE.exec(page.text);
    if (!eol) throw new LayoutChangedError('no "Model EOL date" line');
    const row = (retirement: PageDate | null, exact: boolean, excerpt: string): ExtractedRow => ({
      platform: 'bedrock',
      provider: id.split('.')[0] as string,
      model_id: id,
      version: null,
      regions: null,
      state: exact ? 'deprecated' : 'available',
      deprecation: null,
      retirement,
      qualifier: exact ? 'exact' : 'no_earlier_than',
      replacements: [],
      excerpt,
      notes: other ? `The card also lists ${other.id}, the model ID on ${other.endpoint}.` : null,
    });

    // An announced EOL date replaces the earliest possible one.
    const date = parse(eol[1] as string, eol[0]);
    if (date === undefined) return { rows: [], problems, exhaustive: true };
    if (date) return { rows: [row(date, true, eol[0].trim())], problems, exhaustive: true };
    if (noSooner) {
      const earliest = parse(noSooner[1] as string, noSooner[0]);
      if (earliest === undefined) return { rows: [], problems, exhaustive: true };
      return { rows: [row(earliest, false, noSooner[0].trim())], problems, exhaustive: true };
    }
    return { rows: [row(null, false, eol[0].trim())], problems, exhaustive: true };
  },
};
