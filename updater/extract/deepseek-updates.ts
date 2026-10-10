// Parser for `deepseek/updates`, best effort. DeepSeek publishes only a free-text
// change log (`## Date: YYYY-MM-DD` sections), so lifecycle dates can't be read reliably. The
// parser finds every API model name the log mentions (`deepseek-…`, lowercase as written in code)
// and returns one `unverified` row per name, with the first (newest) sentence that mentions it as
// the excerpt. The extraction is not exhaustive: the merge never changes DeepSeek entries, and
// names the registry doesn't know yet are listed for review by hand.
import type { Extractor } from '../../src/core/ports.ts';
import { type ExtractedRow, LayoutChangedError } from '../../src/core/registry/extract.ts';

const DATE_HEADING = /^#{1,6}\s+Date:\s*(\d{4}-\d{2}-\d{2})\s*$/;
// A model name: not inside a longer word, and without a trailing sentence period.
const MODEL_ID = /(?<![A-Za-z0-9_.-])deepseek-[a-z0-9]+(?:[-.][a-z0-9]+)*/g;
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z"'(])/;

export const extractor: Extractor = {
  id: 'deepseek-updates',
  extract(page) {
    const rows = new Map<string, ExtractedRow>();
    let date: string | null = null;
    let sections = 0;
    for (const line of page.text.split('\n')) {
      const heading = DATE_HEADING.exec(line);
      if (heading) {
        date = heading[1] as string;
        sections++;
        continue;
      }
      if (date === null) continue;
      for (const sentence of line.split(SENTENCE_END)) {
        for (const match of sentence.matchAll(MODEL_ID)) {
          const id = match[0];
          if (rows.has(id)) continue;
          rows.set(id, {
            platform: 'deepseek',
            provider: 'deepseek',
            model_id: id,
            version: null,
            regions: null,
            state: 'unverified',
            deprecation: null,
            retirement: null,
            qualifier: 'exact',
            replacements: [],
            excerpt: sentence.trim(),
            notes: `Mentioned in the change log entry of ${date}.`,
          });
        }
      }
    }
    if (sections === 0) throw new LayoutChangedError('no `## Date: YYYY-MM-DD` sections');
    if (rows.size === 0) throw new LayoutChangedError('no `deepseek-…` model names');
    return { rows: [...rows.values()], problems: [], exhaustive: false };
  },
};
