// Helpers shared by the Gemini API and Vertex parsers (Google's docs use the same conventions).
import { parseDateString } from '../../src/core/registry/date-strings.ts';
import type { ExtractedRow, PageDate } from '../../src/core/registry/extract.ts';
import type { DateQualifier } from '../../src/core/types.ts';
import { cellText } from './table.ts';

// A single model ID as Google writes one: lowercase, with at least one `-`, `.` or `@`.
const MODEL_ID = /^[a-z0-9][a-z0-9._@-]*[-.@][a-z0-9._@-]*$/;

/**
 * The replacement IDs a cell names: `a` or `b`, `a`, `b`. Parts that aren't a single model ID
 * (display names such as "Gemma 4", or "the GA models on …") are left out.
 */
export function replacementIds(cell: string): string[] {
  return cellText(cell)
    .split(/\s*(?:,|\bor\b|\band\b)\s*/)
    .map((part) => part.trim())
    .filter((part) => MODEL_ID.test(part));
}

/** A model ID cell: the first code span, without a trailing footnote mark (`id\*`). */
export function modelIdOf(cell: string): string | null {
  const match = /`([^`]+)`/.exec(cell);
  if (!match) return null;
  return (match[1] as string).replace(/\\?\*+$/, '').trim() || null;
}

export type CellDate =
  | { kind: 'date'; date: PageDate; qualifier: DateQualifier }
  | { kind: 'none' }
  | { kind: 'invalid'; text: string };

/** Reads a date cell or phrase; `text` keeps the qualifier words so the excerpt grounds it. */
export function readDate(raw: string): CellDate {
  const text = cellText(raw).replace(/\.$/, '');
  const parsed = parseDateString(text);
  if (parsed.kind === 'none') return { kind: 'none' };
  if (parsed.kind === 'invalid') return { kind: 'invalid', text };
  return { kind: 'date', date: { text, iso: parsed.iso }, qualifier: parsed.qualifier };
}

// Who makes a partner model, by the first word of its ID. Data, not per-model rules: one prefix
// covers a model family.
const MAKERS: Record<string, string> = {
  claude: 'anthropic',
  jamba: 'ai21',
  llama: 'meta',
  mistral: 'mistral',
  codestral: 'mistral',
  ministral: 'mistral',
  deepseek: 'deepseek',
  qwen: 'qwen',
  gpt: 'openai',
  grok: 'xai',
  kimi: 'moonshotai',
  glm: 'zai',
  minimax: 'minimax',
  // intfloat's multilingual-e5 embedding models.
  multilingual: 'intfloat',
};

/** The model maker for a partner-model ID, or null when the family is unknown. */
export function partnerMaker(modelId: string): string | null {
  const family = /^[a-z]+/.exec(modelId)?.[0];
  return (family && MAKERS[family]) ?? null;
}

/**
 * Drops rows that repeat an earlier row of the same model with the same values (Google lists some
 * models in two tables). A repeat with different values is a problem: the page contradicts itself.
 */
export function dedupeRows(rows: ExtractedRow[], problems: string[]): ExtractedRow[] {
  const values = (row: ExtractedRow) =>
    JSON.stringify([row.state, row.retirement?.iso, row.qualifier, row.replacements]);
  const first = new Map<string, ExtractedRow>();
  const out: ExtractedRow[] = [];
  for (const row of rows) {
    const earlier = first.get(row.model_id);
    if (!earlier) {
      first.set(row.model_id, row);
      out.push(row);
    } else if (values(earlier) !== values(row)) {
      problems.push(`\`${row.model_id}\` is listed twice with different values`);
    }
  }
  return out;
}
