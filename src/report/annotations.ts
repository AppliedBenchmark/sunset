// Workflow annotations. GitHub shows at most 10 errors and 10 warnings per step (the
// toolkit docs give the same for notices, and 50 per job), so the most severe come first and, when
// some don't fit, one notice points to the job summary. One slot per level is left for the
// Action's own message (the failure, a registry warning, a notice), which would otherwise be the
// one GitHub drops. The Action passes each one to `core.error`, `core.warning` or `core.notice`.
// Docs mentions are never annotated.
import type { ScanResult } from '../core/types.ts';
import { bySeverity, type Item, items, plural } from './common.ts';
import { RULE_INFO } from './rules.ts';

export const ANNOTATIONS_PER_LEVEL = 10;

export type AnnotationLevel = 'error' | 'warning' | 'notice';

/** The shape of `@actions/core`'s AnnotationProperties, plus the level and message. */
export interface Annotation {
  level: AnnotationLevel;
  message: string;
  title: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  /** Only set when the annotation is on one line; GitHub ignores columns otherwise. */
  startColumn?: number;
  endColumn?: number;
}

export interface AnnotationOptions {
  perLevel?: number;
}

function title(item: Item): string {
  const rule = RULE_INFO[item.rule as keyof typeof RULE_INFO];
  if (!rule) return `Sunset: ${item.rule.replace(/-/g, ' ')}`;
  return `${rule.title}: ${item.subject}`;
}

function toAnnotation(item: Item): Annotation {
  const l = item.location;
  return {
    level: item.severity,
    message: item.message,
    title: title(item),
    file: l.path,
    startLine: l.line,
    endLine: l.endLine,
    ...(l.line === l.endLine ? { startColumn: l.column, endColumn: l.endColumn } : {}),
  };
}

export function annotations(result: ScanResult, opts: AnnotationOptions = {}): Annotation[] {
  const limit = opts.perLevel ?? ANNOTATIONS_PER_LEVEL;
  const perLevel = limit - 1;
  const all = items(result).sort(bySeverity);
  const byLevel = (level: AnnotationLevel) => all.filter((i) => i.severity === level);
  const errors = byLevel('error');
  const warnings = byLevel('warning');
  const notices = byLevel('notice');

  const overflow =
    errors.length > perLevel || warnings.length > perLevel || notices.length > perLevel;
  // The pointer is a notice too, so it takes one of the notice slots.
  const shown = [
    ...errors.slice(0, perLevel),
    ...warnings.slice(0, perLevel),
    ...notices.slice(0, overflow ? perLevel - 1 : perLevel),
  ];
  const out = shown.map(toAnnotation);
  if (overflow) {
    const hidden = all.length - shown.length;
    out.push({
      level: 'notice',
      title: 'Sunset: more findings',
      message: `${plural(hidden, 'more finding')} ${hidden === 1 ? 'is' : 'are'} not annotated, because GitHub shows at most ${limit} annotations per level. See the job summary for the full list.`,
    });
  }
  return out;
}
