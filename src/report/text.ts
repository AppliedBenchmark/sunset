// The terminal report: findings grouped by severity, then a one-line tally. Colors are
// applied through an injected Style, so this stays pure; the CLI passes one built on
// `util.styleText`, which honors NO_COLOR and FORCE_COLOR and turns colors off off a TTY.
import type { ScanResult, Severity } from '../core/types.ts';
import {
  at,
  bySeverity,
  countFindings,
  type Item,
  items,
  plural,
  type ReportContext,
  registryLine,
} from './common.ts';

/** The `util.styleText` formats the report uses. */
export type TextFormat = 'red' | 'yellow' | 'cyan' | 'bold' | 'dim';

export type Style = (format: TextFormat | readonly TextFormat[], text: string) => string;

export const plainStyle: Style = (_format, text) => text;

/**
 * Control characters, and the bidirectional overrides of "Trojan Source", from a terminal's point
 * of view. File names, model IDs and expressions come from the scanned repository, so they could
 * otherwise clear the screen, rewrite earlier lines, or write to the clipboard (OSC 52).
 */
const unprintable = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * `text` with every unprintable character shown as a `\uXXXX` escape, and with anything a runner
 * would read as a workflow command escaped the same way: `::` at the start, after spaces, and the
 * older `##[` anywhere. GitHub reads them in any step's output, so the CLI's too.
 */
export function printable(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    out += unprintable(code) ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return out.replace(/^( *)::/, '$1\\u003a:').replaceAll('##[', '##\\u005b');
}

/** `printable`, line by line: line breaks stay, as `\n`. */
export const printableLines = (text: string): string =>
  text.split(/\r?\n/).map(printable).join('\n');

export interface TextOptions {
  style?: Style;
}

const HEADINGS: Record<Severity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  notice: 'Notices',
};

const COLORS: Record<Severity, TextFormat> = { error: 'red', warning: 'yellow', notice: 'cyan' };

export function textReport(result: ScanResult, ctx: ReportContext, opts: TextOptions = {}): string {
  const style = opts.style ?? plainStyle;
  const all = items(result).sort(bySeverity);
  const findings = new Set<unknown>(result.findings);
  const out: string[] = [];

  // Findings by severity, then unresolved references and directive problems on their own, so
  // each heading's count matches the tally.
  const groups: [string, TextFormat, Item[]][] = [
    ...(['error', 'warning', 'notice'] as const).map((severity): [string, TextFormat, Item[]] => [
      HEADINGS[severity],
      COLORS[severity],
      all.filter((i) => i.severity === severity && findings.has(i.source)),
    ]),
    ['Unresolved references', 'cyan', all.filter((i) => i.rule === 'model-reference-unresolved')],
  ];
  for (const [heading, color, group] of groups) {
    if (group.length === 0) continue;
    out.push(style([color, 'bold'], `${heading} (${group.length})`), '');
    for (const item of group) out.push(...renderItem(item, style), '');
  }

  if (result.diagnostics.length > 0) {
    out.push(style('bold', `Directive and config problems (${result.diagnostics.length})`), '');
    for (const d of result.diagnostics) {
      const message = printable(d.message);
      out.push(d.location ? `  ${printable(at(d.location))}  ${message}` : `  ${message}`);
    }
    out.push('');
  }

  out.push(tally(result, style), style('dim', footer(result, ctx)));
  return `${out.join('\n')}\n`;
}

function renderItem(item: Item, style: Style): string[] {
  const head = `  ${style(COLORS[item.severity], item.severity.padEnd(7))} ${printable(at(item.location))}  ${style('dim', item.rule)}`;
  return [head, `    ${printable(item.message)}`];
}

function tally(result: ScanResult, style: Style): string {
  const counts = countFindings(result.findings);
  const parts = [
    style(counts.error ? ['red', 'bold'] : 'bold', plural(counts.error, 'error')),
    style(counts.warning ? ['yellow', 'bold'] : 'bold', plural(counts.warning, 'warning')),
    plural(counts.notice, 'notice'),
  ];
  const extra = [
    result.unresolved.length && plural(result.unresolved.length, 'unresolved reference'),
    result.mentions.length && `${plural(result.mentions.length, 'mention')} in docs`,
    result.suppressed.length && `${result.suppressed.length.toLocaleString('en-US')} suppressed`,
  ].filter((p): p is string => typeof p === 'string');
  return [parts.join(', '), ...extra].join(' · ');
}

function footer(result: ScanResult, ctx: ReportContext): string {
  const files = result.stats.files;
  return `Scanned ${plural(files.scanned, 'file')} on ${result.today} with sunset ${ctx.version}, ${registryLine(result, ctx)}.`;
}
