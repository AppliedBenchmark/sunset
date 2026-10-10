// Parser for `mistral/models`: the model files of mistralai/platform-docs-public, concatenated by
// the fetcher with `==> <path> <==` headers. The files are TypeScript from a third party, so they
// are read as text with regular expressions and never executed.
//
// From each file: `identifiers: { apiNames: [...] }`, `status: '…'` and
// `metadata: { deprecationDate, retirementDate, replacement }`.
// - `status` is one of the repository's ModelStatus values: GA, PublicPreview, Deprecated or
//   Retired. Any other value is a problem rather than a model read as available.
// - Every API name is a row. A floating `*-latest` name moves to newer models; its row has the
//   values of the model file that lists it, and its entry follows the name when it moves. A move
//   that would take the entry out of `retired` waits for a person, like any other.
// - The excerpt runs from the `identifiers:` line to the end of `metadata`, so it carries the
//   names, dates and replacement together.
// - Replacements are display names ("Mistral Small 4") except when they look like an API ID;
//   only IDs are recorded.
// - An ID listed in several files collapses to the first file when the values agree; when they
//   don't, it becomes an `unverified` row with no dates. A `*-latest` name can be in two files
//   while it moves (`voxtral-mini-latest`).
import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  LayoutChangedError,
  type PageDate,
  type PageState,
} from '../../src/core/registry/extract.ts';

const FILE_HEADER = /^==> (.+) <==$/;
const API_NAMES = /^identifiers:\s*\{\s*apiNames:\s*\[([^\]]*)\]/;
const METADATA = /^metadata:\s*\{/;
const STATUS = /^status:\s*'([^']*)'/m;
const SLUG = /^slug:\s*'([^']*)'/m;
const TAGS = /^tags:\s*\[([^\]]*)\]/m;
const FIELD = /\b(deprecationDate|retirementDate|replacement):\s*'([^']*)'/g;
const QUOTED = /'([^']+)'/g;
const FLOATING = /(?:^|-)latest$/;
const API_ID = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
// `ModelStatus` in src/schema/models/schema.ts of mistralai/platform-docs-public.
const STATUSES = new Set(['GA', 'PublicPreview', 'Deprecated', 'Retired']);

interface FileModel {
  file: string;
  names: string[];
  row: Omit<ExtractedRow, 'model_id' | 'notes'>;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function splitFiles(text: string): { path: string; lines: string[] }[] {
  const files: { path: string; lines: string[] }[] = [];
  for (const line of text.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header) files.push({ path: header[1] as string, lines: [] });
    else files.at(-1)?.lines.push(line);
  }
  return files;
}

function readFile(path: string, lines: string[], problems: string[]): FileModel | null {
  const file = basename(path);
  const body = lines.join('\n');
  const start = lines.findIndex((line) => API_NAMES.test(line));
  const metaStart = lines.findIndex((line) => METADATA.test(line));
  if (start < 0 || metaStart < 0) {
    problems.push(`${file}: no \`identifiers: { apiNames }\` or \`metadata\` line`);
    return null;
  }
  // `metadata` ends at its first closing brace; its values are flat.
  let metaEnd = metaStart;
  while (metaEnd < lines.length && !(lines[metaEnd] as string).includes('}')) metaEnd++;
  if (metaEnd >= lines.length || metaEnd < start) {
    problems.push(`${file}: can't find the end of \`metadata\``);
    return null;
  }
  const metadata = lines.slice(metaStart, metaEnd + 1).join(' ');
  const excerpt = lines
    .slice(start, metaEnd + 1)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
  const names = [...(API_NAMES.exec(lines[start] as string)?.[1] ?? '').matchAll(QUOTED)].map(
    (m) => m[1] as string,
  );

  const fields: Record<string, string> = {};
  for (const m of metadata.matchAll(FIELD)) fields[m[1] as string] = (m[2] as string).trim();
  const date = (field: 'deprecationDate' | 'retirementDate'): PageDate | null | undefined => {
    const value = fields[field];
    if (value === undefined) return null;
    const parsed = parseDateString(value);
    if (parsed.kind === 'none') return null;
    if (parsed.kind === 'invalid') {
      problems.push(`${file}: ${field} '${value}' isn't an accepted date format`);
      return undefined;
    }
    return { text: value, iso: parsed.iso };
  };
  const deprecation = date('deprecationDate');
  const retirement = date('retirementDate');
  if (deprecation === undefined || retirement === undefined) return null;

  const status = STATUS.exec(body)?.[1];
  if (status === undefined || !STATUSES.has(status)) {
    problems.push(`${file}: unknown status ${status === undefined ? '(none)' : `'${status}'`}`);
    return null;
  }
  let state: PageState;
  if (status === 'Retired') state = retirement ? 'retired' : 'unverified';
  else if (status === 'Deprecated' || deprecation || retirement) state = 'deprecated';
  else state = 'available';

  const replacement = fields.replacement;
  const thirdParty = /'third-party'/.test(TAGS.exec(body)?.[1] ?? '');
  const slug = SLUG.exec(body)?.[1] ?? '';
  const unverified = state === 'unverified';
  return {
    file,
    names,
    row: {
      platform: 'mistral',
      provider: thirdParty && slug ? (slug.split('-')[0] as string) : 'mistral',
      version: null,
      regions: null,
      state,
      deprecation: unverified ? null : deprecation,
      retirement: unverified ? null : retirement,
      qualifier: 'exact',
      replacements:
        !unverified && replacement && API_ID.test(replacement) && !names.includes(replacement)
          ? [replacement]
          : [],
      excerpt,
    },
  };
}

const valuesOf = (row: FileModel['row']) =>
  JSON.stringify([row.state, row.deprecation?.iso, row.retirement?.iso, row.replacements]);

export const extractor: Extractor = {
  id: 'mistral-model-files',
  extract(page) {
    const files = splitFiles(page.text);
    if (files.length === 0) throw new LayoutChangedError('no `==> <path> <==` model files');
    const problems: string[] = [];
    const byId = new Map<string, FileModel[]>();
    for (const { path, lines } of files) {
      const model = readFile(path, lines, problems);
      if (!model) continue;
      for (const name of model.names) {
        byId.set(name, [...(byId.get(name) ?? []), model]);
      }
    }
    const rows: ExtractedRow[] = [];
    for (const [id, models] of byId) {
      const first = models[0] as FileModel;
      const others = first.names.filter((n) => n !== id && !FLOATING.test(n));
      const agree = models.every((m) => valuesOf(m.row) === valuesOf(first.row));
      let notes: string | null = others.length
        ? `The same model file also lists ${others.join(', ')}.`
        : null;
      let row = first.row;
      if (models.length > 1) {
        notes = agree
          ? `Listed in ${models.length} model files with the same dates; the excerpt is from ${first.file}.`
          : `Listed in ${models.length} model files with different dates; left unverified.`;
        if (!agree) {
          row = {
            ...row,
            state: 'unverified',
            deprecation: null,
            retirement: null,
            replacements: [],
          };
        }
      }
      if (FLOATING.test(id))
        notes = `A floating name, which moves to newer models. ${notes ?? ''}`.trim();
      rows.push({ ...row, model_id: id, notes });
    }
    if (rows.length === 0) {
      throw new LayoutChangedError(
        `no API names in any model file${problems.length ? ` (${problems[0]}, …)` : ''}`,
      );
    }
    return { rows, problems, exhaustive: true };
  },
};
