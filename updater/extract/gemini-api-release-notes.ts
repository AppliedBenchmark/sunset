// Parser for the Gemini API release notes (`parser: gemini-api-release-notes`). The deprecations
// table drops models some time after they shut down; the release notes keep saying so. One
// `## <Month D, YYYY>` section per day, with bullets in free text, so only two shapes are read,
// and only as the first bullet of a section:
//
//   ## September 29, 2025                    ## May 25, 2026
//
//   - The following Gemini 1.5 models are    - The `gemini-3.1-flash-lite-preview` model has
//     now shut down:                           been shut down. …
//   - `gemini-1.5-pro`
//   - `gemini-1.5-flash`
//
// - The date is the heading's, so the excerpt runs from the heading through the bullet, and
//   through the list of IDs that follows it. A shut-down bullet further down a section can't be
//   quoted with the date without the bullets between them, so it is left out.
// - The models are retired on that date. The notes name no replacement IDs for these shapes.
// - Release notes repeat shutdowns the deprecations table lists; the merge leaves those to
//   gemini-api/deprecations (ADDS_ONLY_PARSERS in merge.ts).
// - The markdown loses list nesting, so the list is the run of `- \`<id>\`` lines after the
//   bullet; another line in that run starting with a code span is a problem.

import type { Extractor } from '../../src/core/ports.ts';
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import {
  type ExtractedRow,
  type Extraction,
  LayoutChangedError,
  type PageDate,
} from '../../src/core/registry/extract.ts';
import { dedupeRows } from './google.ts';

const HEADING = /^## (.+)$/;
const LIST_INTRO = /^- The following (?:[\w .-]+ )?models? (?:are|is) (?:now )?shut down:$/;
const SINGLE = /^- (?:The )?`([^`]+)`(?: model)? (?:has been|is) shut down\./;
const ITEM = /^- `([^`]+)`$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

interface Section {
  heading: string;
  date: PageDate;
  lines: string[];
}

function sections(text: string): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      const parsed = parseDateString(heading[1] as string);
      current =
        parsed.kind === 'date' && parsed.qualifier === 'exact'
          ? { heading: line, date: { text: parsed.date, iso: parsed.iso }, lines: [] }
          : null;
      if (current) out.push(current);
    } else {
      current?.lines.push(line);
    }
  }
  return out;
}

/** The IDs a section's first bullet says are shut down, with the excerpt that quotes them. */
function shutDown(section: Section, problems: string[]): { ids: string[]; excerpt: string } | null {
  const lines = section.lines;
  let i = lines.findIndex((line) => line !== '');
  const first = lines[i] ?? '';
  const single = SINGLE.exec(first);
  if (single) {
    const sentence = first.slice(0, first.indexOf(' shut down.') + ' shut down.'.length);
    return { ids: [single[1] as string], excerpt: `${section.heading} ${sentence}` };
  }
  if (!LIST_INTRO.test(first)) return null;
  const quoted = [section.heading, first];
  const ids: string[] = [];
  i++;
  if (lines[i] === '') i++;
  for (; i < lines.length && (lines[i] as string).startsWith('- `'); i++) {
    const line = lines[i] as string;
    const item = ITEM.exec(line);
    if (!item) {
      problems.push(`${section.heading}: a list item the parser doesn't read: ${line}`);
      return null;
    }
    quoted.push(line);
    ids.push(item[1] as string);
  }
  if (ids.length === 0) {
    problems.push(`${section.heading}: no model IDs after "${first}"`);
    return null;
  }
  return { ids, excerpt: quoted.join(' ') };
}

export const extractor: Extractor = {
  id: 'gemini-api-release-notes',
  extract(page): Extraction {
    const problems: string[] = [];
    const rows: ExtractedRow[] = [];
    const all = sections(page.text);
    if (all.length === 0) throw new LayoutChangedError('no `## <Month D, YYYY>` sections');
    for (const section of all) {
      const found = shutDown(section, problems);
      if (!found) continue;
      for (const id of found.ids) {
        if (!MODEL_ID.test(id)) {
          problems.push(`${section.heading}: \`${id}\` isn't a model ID`);
          continue;
        }
        rows.push({
          platform: 'gemini-api',
          provider: 'google',
          model_id: id,
          version: null,
          regions: null,
          state: 'retired',
          deprecation: null,
          retirement: section.date,
          qualifier: 'exact',
          replacements: [],
          excerpt: found.excerpt,
          notes: null,
        });
      }
    }
    if (rows.length === 0 && problems.length === 0) {
      throw new LayoutChangedError('no section starts with a shut-down announcement');
    }
    return { rows: dedupeRows(rows, problems), problems, exhaustive: true };
  },
};
