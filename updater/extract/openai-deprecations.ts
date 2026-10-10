// Parser for OpenAI's deprecations page (`parser: openai-deprecations`). Each announcement is a
// `### YYYY-MM-DD: <title>` heading followed by tables whose first column is `Shutdown date`; the
// other headers vary.
//
// Rules:
// - A table is read when it has a `Shutdown date` column, a model column (`Model / system`,
//   `Model family / snapshot`, `Model snapshot`, `Deprecated model` or `Legacy model`) and a
//   replacement column (`Recommended replacement…` or `Substitute model`). `System` tables list
//   endpoints and are skipped; any other table with `Shutdown date` is a problem, so a renamed
//   column can't drop its models silently.
// - A model cell is read only when it starts with a code span (bold or not); every code span in
//   it is a model ID (`gpt-4-0613` \| `gpt-4`, … lists aliases that retire with the snapshot).
//   Cells such as "New fine-tuning training on `babbage-002`" or "Videos API" aren't models; a
//   cell that is a bare model ID without code marks is a problem. Endpoints (`/v1/…`) and
//   fine-tuned versions (`ft-…`) are skipped.
// - Replacements are the code spans of the replacement cell that look like model IDs, so
//   footnoted (`gpt-4.1*`) and parameter (`reasoning.mode: pro`) spans are left out.
// - A model listed by several announcements takes the row of the newest one; within one
//   announcement, the first row on the page.
// - Every listed model is deprecated (retired once its date passes); `Legacy model` tables are
//   legacy.
import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageState,
} from '../../src/core/registry/extract.ts';
import {
  cellText,
  codeSpans,
  looksLikeId,
  startsWithCode,
  type Table,
  tables,
  unreadTables,
} from './table.ts';

const MODEL_HEADERS = [
  'model / system',
  'model family / snapshot',
  'model snapshot',
  'deprecated model',
  'legacy model',
];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ANNOUNCEMENT = /^(\d{4}-\d{2}-\d{2}):/;

function isModelId(span: string): boolean {
  return MODEL_ID.test(span) && !span.startsWith('ft-');
}

interface Candidate {
  row: ExtractedRow;
  /** The announcement date, `YYYY-MM-DD`; '' when the heading has none. */
  announced: string;
  order: number;
}

export const extractor: Extractor = {
  id: 'openai-deprecations',
  extract(page) {
    const problems: string[] = [];
    const best = new Map<string, Candidate>();
    let order = 0;
    const all = tables(page.text);
    const read = new Set<Table>();
    for (const table of all) {
      const lower = table.headers.map((h) => h.toLowerCase());
      const date = lower.indexOf('shutdown date');
      const model = lower.findIndex((h) => MODEL_HEADERS.includes(h));
      const replacement = lower.findIndex(
        (h) => h.startsWith('recommended replacement') || h === 'substitute model',
      );
      if (date < 0 || model < 0 || replacement < 0) continue;
      read.add(table);
      const state: PageState = lower[model] === 'legacy model' ? 'legacy' : 'deprecated';
      const announced =
        [...table.headings]
          .reverse()
          .map((h) => ANNOUNCEMENT.exec(h)?.[1])
          .find((d) => d !== undefined) ?? '';
      for (const tableRow of table.rows) {
        const modelCell = tableRow.cells[model] ?? '';
        if (!startsWithCode(modelCell)) {
          if (looksLikeId(cellText(modelCell))) {
            problems.push(
              `a model without code marks, which the parser doesn't read: ${tableRow.line}`,
            );
          }
          continue;
        }
        const ids = codeSpans(modelCell).filter(isModelId);
        if (ids.length === 0) continue;
        const dateText = cellText(tableRow.cells[date] ?? '');
        const parsed = parseDateString(dateText);
        if (parsed.kind === 'invalid') {
          problems.push(`unrecognized shutdown date "${dateText}" in: ${tableRow.line}`);
          continue;
        }
        const replacements = codeSpans(tableRow.cells[replacement] ?? '').filter(isModelId);
        for (const id of ids) {
          const row: ExtractedRow = {
            platform: 'openai',
            provider: 'openai',
            model_id: id,
            version: null,
            regions: null,
            state,
            deprecation: null,
            retirement: parsed.kind === 'date' ? { text: dateText, iso: parsed.iso } : null,
            qualifier: parsed.kind === 'date' ? parsed.qualifier : 'exact',
            replacements: replacements.filter((r) => r !== id),
            excerpt: tableRow.line,
            notes: null,
          };
          const previous = best.get(id);
          if (!previous || announced > previous.announced) {
            best.set(id, { row, announced, order: order++ });
          }
        }
      }
    }
    problems.push(...unreadTables(all, (t) => read.has(t), ['Shutdown date'], ['System']));
    if (read.size === 0 || best.size === 0) {
      throw new LayoutChangedError(
        'no table with `Shutdown date`, a model column and a replacement column',
      );
    }
    const rows = [...best.values()].sort((a, b) => a.order - b.order).map((c) => c.row);
    return { rows, problems, exhaustive: true };
  },
};
