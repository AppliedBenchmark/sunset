// What every reporter shares: the run's context, counts, and the list of reportable items.
import { daysBetween } from '../core/dates.ts';
import type { LoadedRegistry } from '../core/ports.ts';
import { compareLocations } from '../core/scan/lines.ts';
import { compareSeverity } from '../core/severity.ts';
import type {
  Diagnostic,
  Finding,
  Location,
  RegistryEntry,
  ScanResult,
  Severity,
  UnresolvedReference,
} from '../core/types.ts';

/** Facts about the run that aren't in the ScanResult. Adapters fill it in. */
export interface ReportContext {
  /** Sunset's version. */
  version: string;
  /** Where the registry came from; null when the caller doesn't know. */
  registryOrigin: LoadedRegistry['origin'] | null;
  /** A link to a location, e.g. a blob URL at the scanned commit. Without it, paths are plain text. */
  fileUrl?: (location: Location) => string;
}

export interface Counts {
  error: number;
  warning: number;
  notice: number;
}

/** Findings by severity. Unresolved references and diagnostics are counted separately. */
export function countFindings(findings: readonly Finding[]): Counts {
  const counts: Counts = { error: 0, warning: 0, notice: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** Whole days since the registry's newest check, or null without one. */
export function registryAgeDays(result: ScanResult): number | null {
  const newest = result.registry.newestCheck;
  return newest === null ? null : daysBetween(newest, result.today);
}

/** `bundled registry v12 (585 entries, last checked 2026-10-07, 1 day ago)` */
export function registryLine(result: ScanResult, ctx: ReportContext): string {
  const { registryVersion, entries, newestCheck } = result.registry;
  const origin = ctx.registryOrigin ? `${ctx.registryOrigin} registry` : 'registry';
  const version = registryVersion === null ? '' : ` v${registryVersion}`;
  const age = registryAgeDays(result);
  const checked =
    newestCheck === null || age === null ? '' : `, last checked ${newestCheck}, ${ago(age)}`;
  return `${origin}${version} (${plural(entries, 'entry', 'entries')}${checked})`;
}

function ago(days: number): string {
  if (days <= 0) return 'today';
  return `${plural(days, 'day')} ago`;
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * One reportable line: a finding, an unresolved reference or a located diagnostic. These are what
 * annotations and SARIF results are made of; docs mentions never are.
 */
export interface Item {
  severity: Severity;
  /** A rule ID, or the diagnostic kind. */
  rule: string;
  location: Location;
  message: string;
  /** The model ID or expression, for titles. */
  subject: string;
  source: Finding | UnresolvedReference | Diagnostic;
}

export function items(result: ScanResult): Item[] {
  const out: Item[] = [
    ...result.findings.map(
      (f): Item => ({
        severity: f.severity,
        rule: f.rule,
        location: f.location,
        message: f.message,
        subject: f.modelId,
        source: f,
      }),
    ),
    ...result.unresolved.map(
      (u): Item => ({
        severity: u.severity,
        rule: u.rule,
        location: u.location,
        message: u.message,
        subject: u.expression,
        source: u,
      }),
    ),
  ];
  for (const d of result.diagnostics) {
    if (!d.location) continue;
    out.push({
      severity: 'notice',
      rule: d.kind,
      location: d.location,
      message: d.message,
      subject: d.kind,
      source: d,
    });
  }
  return out.sort(byLocation);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const byLocation = (a: Item, b: Item): number =>
  compareLocations(a.location, b.location) || cmp(a.rule, b.rule);

/** Most severe first, then by location. */
export const bySeverity = (a: Item, b: Item): number =>
  compareSeverity(a.severity, b.severity) || byLocation(a, b);

export const at = (l: Location): string => `${l.path}:${l.line}:${l.column}`;

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────

/**
 * Text safe inside a table cell: one line, no pipes, nothing GitHub turns into HTML, a link, an
 * image or a mention. Messages carry text from the scanned code and from the registry, so this
 * doesn't trust any of it: code spans are fenced anew, and every other word that could start
 * markup (`@`, `[`, `]`, `<`, `>`, `&`, `\`, a stray backtick, `://`, `www.`) becomes a code span
 * too, which GitHub shows as it is.
 */
export function cell(text: string): string {
  return codeSpans(text.replace(/\s+/g, ' ').trim())
    .map((part) => (part.code ? code(part.text) : part.text.split(' ').map(safeWord).join(' ')))
    .join('');
}

const RISKY = /[@[\]<>&\\`]|:\/\/|^\(*www\./i;

function safeWord(word: string): string {
  if (!RISKY.test(word)) return word.replace(/\|/g, '\\|');
  // Keep brackets and punctuation around the word outside the code span: `(x).` stays readable.
  const [, lead, body, tail] = /^(\(*)(.*?)([).,;:]*)$/.exec(word) as RegExpExecArray;
  return `${lead}${code(body as string)}${tail}`;
}

/** Text split into code spans and the text between them, read as CommonMark reads backticks. */
function codeSpans(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const open = /^`+/.exec(text.slice(i))?.[0] as string;
    const close = new RegExp(`(?<!\`)${open}(?!\`)`, 'g');
    close.lastIndex = i + open.length;
    const end = close.exec(text);
    if (!end) {
      // A run with no closing run of the same length is literal text.
      i += open.length;
      continue;
    }
    if (i > from) out.push({ code: false, text: text.slice(from, i) });
    const inner = text.slice(i + open.length, end.index);
    const padded = inner.length > 1 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim();
    out.push({ code: true, text: padded ? inner.slice(1, -1) : inner });
    i = end.index + open.length;
    from = i;
  }
  if (from < text.length) out.push({ code: false, text: text.slice(from) });
  return out;
}

/**
 * An inline code span that survives backticks in the text. In a table cell, pipes must be escaped
 * even inside code (GFM); elsewhere the backslash would show.
 */
export function code(text: string, inTable = true): string {
  const spaced = text.replace(/\s+/g, ' ');
  const clean = inTable ? spaced.replace(/\|/g, '\\|') : spaced;
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** `path:line`, linked when the context can build a URL. */
export function locationLink(location: Location, ctx: ReportContext): string {
  const label = code(`${location.path}:${location.line}`);
  return ctx.fileUrl ? `[${label}](${ctx.fileUrl(location)})` : label;
}

/** `openai`, or `azure-openai 2024-05-13` for versioned entries; Markdown. */
export function entryName(entry: RegistryEntry): string {
  return entry.version ? `${entry.platform} ${cell(entry.version)}` : entry.platform;
}

export function replacementsText(entry: RegistryEntry | null): string {
  if (!entry || entry.recommended_replacements.length === 0) return '';
  const list = entry.recommended_replacements
    .map((r) =>
      r.platform === entry.platform ? code(r.model_id) : `${code(r.model_id)} (${r.platform})`,
    )
    .join(', ');
  return entry.drop_in ? `${list} (drop-in)` : list;
}

const encoder = new TextEncoder();

export const utf8Bytes = (text: string): number => encoder.encode(text).length;
