// Suppression. Inline directives are read only inside comment spans:
//
//   <prefix>-ignore             the line the directive is on
//   <prefix>-ignore-next-line   the line after the comment ends
//   <prefix>-ignore-file        the whole file
//
// each with optional `until=YYYY-MM-DD` and `reason="…"`. Config ignores match by path glob,
// model ID and rule, also with `until`. An expired suppression stops applying and is reported;
// a malformed directive never applies and is reported too.
import picomatch from 'picomatch';
import { parseIsoDate } from '../dates.ts';
import type { IsoDate, RuleId, Spans } from '../types.ts';
import type { LineIndex } from './lines.ts';

export const DEFAULT_DIRECTIVE_PREFIX = 'sunset';

export type DirectiveKind = 'ignore' | 'ignore-next-line' | 'ignore-file';

export interface Directive {
  kind: DirectiveKind;
  /** The line it applies to (1-based); 0 for the whole file. */
  line: number;
  until: IsoDate | null;
  reason: string | null;
  /** Where the directive text is. */
  start: number;
  end: number;
  text: string;
}

export interface MalformedDirective {
  start: number;
  end: number;
  message: string;
}

const KINDS: readonly DirectiveKind[] = ['ignore', 'ignore-next-line', 'ignore-file'];
const OPTION = /^(until|reason)=(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** Comment closers and decorations that may follow a directive on the same line. */
const TRAILER = /^(?:\*\/|-->|\*\)|#>|\]=*\])?\s*$/;

/** Reads the directives in a file's comment spans. */
export function parseDirectives(
  text: string,
  spans: Spans,
  lines: LineIndex,
  prefix = DEFAULT_DIRECTIVE_PREFIX,
): { directives: Directive[]; malformed: MalformedDirective[] } {
  const directives: Directive[] = [];
  const malformed: MalformedDirective[] = [];
  const pattern = new RegExp(`(?<![\\w-])${prefix}-(ignore[\\w-]*)`, 'g');

  for (const span of spans) {
    if (span.kind !== 'comment') continue;
    const comment = text.slice(span.start, span.end);
    if (!comment.includes(`${prefix}-ignore`)) continue;
    for (const m of comment.matchAll(pattern)) {
      const start = span.start + m.index;
      // Options run to the end of the comment's line.
      const lineEnd = comment.indexOf('\n', m.index);
      const restEnd = lineEnd === -1 ? comment.length : lineEnd;
      const end = span.start + restEnd;
      const kind = m[1] as string;
      if (!(KINDS as readonly string[]).includes(kind)) {
        malformed.push({
          start,
          end: start + m[0].length,
          message: `Unknown directive "${prefix}-${kind}". Use ${KINDS.map((k) => `${prefix}-${k}`).join(', ')}.`,
        });
        continue;
      }
      const parsed = parseOptions(comment.slice(m.index + m[0].length, restEnd));
      if (typeof parsed === 'string') {
        malformed.push({ start, end, message: `Malformed "${prefix}-${kind}": ${parsed}` });
        continue;
      }
      // The next line is the one after the comment, which may span lines (as in ESLint).
      let line = 0;
      if (kind === 'ignore') line = lines.lineOf(start) + 1;
      else if (kind === 'ignore-next-line') line = lines.lineOf(span.end - 1) + 2;
      directives.push({
        kind: kind as DirectiveKind,
        line,
        until: parsed.until,
        reason: parsed.reason,
        start,
        end,
        text: text.slice(start, end).trim(),
      });
    }
  }
  return { directives, malformed };
}

function parseOptions(rest: string): { until: IsoDate | null; reason: string | null } | string {
  let until: IsoDate | null = null;
  let reason: string | null = null;
  let s = rest;
  for (;;) {
    s = s.replace(/^[\s,]+/, '');
    if (TRAILER.test(s)) break;
    const m = OPTION.exec(s);
    if (!m)
      return `unexpected "${s.trim().slice(0, 40)}"; options are until=YYYY-MM-DD and reason="…"`;
    const value = (m[2] ?? m[3] ?? m[4]) as string;
    if (m[1] === 'until') {
      const date = parseIsoDate(value);
      if (!date) return `"${value}" is not a valid date (YYYY-MM-DD)`;
      until = date;
    } else {
      reason = value;
    }
    s = s.slice(m[0].length);
  }
  return { until, reason };
}

// ── Config ignores ───────────────────────────────────────────────────────────────────────────

export interface IgnoreRule {
  /** Path globs. */
  paths?: string[];
  /** Model IDs as written, registry `model_id`s or entry `id`s. */
  models?: string[];
  rules?: RuleId[];
  until?: IsoDate;
  reason?: string;
}

export interface Suppressible {
  rule: RuleId;
  path: string;
  line: number;
  /** Every name the reference goes by: the text matched, model IDs and entry IDs. */
  names: readonly string[];
}

export interface CompiledIgnore {
  rule: IgnoreRule;
  index: number;
  expired: boolean;
  matches(item: Suppressible): boolean;
}

export function compileIgnores(rules: readonly IgnoreRule[], today: IsoDate): CompiledIgnore[] {
  return rules.map((rule, index) => {
    const path = rule.paths?.length ? picomatch(rule.paths, { dot: true }) : null;
    return {
      rule,
      index,
      expired: rule.until !== undefined && rule.until < today,
      matches: (item) =>
        (!path || path(item.path)) &&
        (!rule.models?.length || item.names.some((n) => rule.models?.includes(n))) &&
        (!rule.rules?.length || rule.rules.includes(item.rule)),
    };
  });
}

export type Verdict =
  | { suppressed: false }
  | { suppressed: true; by: 'inline' | 'config'; until: IsoDate | null; reason: string | null };

/**
 * Whether `item` is suppressed by a directive or a config ignore that is still in force. Expired
 * ones never apply; the pipeline reports each of them once.
 */
export function judge(
  item: Suppressible,
  directives: readonly Directive[],
  ignores: readonly CompiledIgnore[],
  today: IsoDate,
): Verdict {
  for (const d of directives) {
    if (d.line !== 0 && d.line !== item.line) continue;
    if (d.until !== null && d.until < today) continue;
    return { suppressed: true, by: 'inline', until: d.until, reason: d.reason };
  }
  for (const ignore of ignores) {
    if (ignore.expired || !ignore.matches(item)) continue;
    return {
      suppressed: true,
      by: 'config',
      until: ignore.rule.until ?? null,
      reason: ignore.rule.reason ?? null,
    };
  }
  return { suppressed: false };
}
