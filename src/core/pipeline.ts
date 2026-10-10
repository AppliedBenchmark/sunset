// The scan pipeline:
// files → classify → prefilter → lexer → detectors → resolve → suppress → severity → (reporters).
// Everything here is pure; files and the date come in through ports.
import {
  createReplacementCheck,
  type ReplacementCheck,
  referenceMessage,
  unknownMessage,
  unresolvedMessage,
} from './messages.ts';
import type { Clock, Detector, FileSource, Logger, Matcher } from './ports.ts';
import { routerOf } from './registry/formats.ts';
import { createMatcher } from './registry/matcher.ts';
import { createSuggester, type Suggester } from './registry/suggest.ts';
import { azureDetector } from './scan/azure-detector.ts';
import { type ClassifyOptions, createClassifier, isGeneratedText } from './scan/classify.ts';
import { dynamicDetector } from './scan/dynamic-detector.ts';
import { hasModelLike } from './scan/inventory.ts';
import { lexerFor } from './scan/lexers/index.ts';
import { compareLocations, LineIndex } from './scan/lines.ts';
import { literalDetector } from './scan/literal-detector.ts';
import { CellText, cellLexer, type Notebook, readNotebook } from './scan/notebook.ts';
import {
  type CompiledIgnore,
  compileIgnores,
  DEFAULT_DIRECTIVE_PREFIX,
  type Directive,
  type IgnoreRule,
  judge,
  parseDirectives,
  type Suppressible,
} from './scan/suppress.ts';
import { type Assessment, assessAll } from './severity.ts';
import type {
  ClassifiedFile,
  Diagnostic,
  Finding,
  InventoryItem,
  IsoDate,
  Location,
  Mention,
  Platform,
  PlatformFormats,
  RawFinding,
  Registry,
  RegistryEntry,
  RuleId,
  ScanResult,
  ScanStats,
  SkipReason,
  Spans,
  Suppressed,
  UnresolvedReference,
} from './types.ts';

export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
/**
 * Notebooks are read up to this size. Images and other outputs make up most of a large notebook,
 * and they aren't scanned, so `maxFileSize` applies to the code cells instead.
 */
const MAX_NOTEBOOK_SIZE = 32 * 1024 * 1024;
export const DEFAULT_DETECTORS: readonly Detector[] = [
  literalDetector,
  dynamicDetector,
  azureDetector,
];

export interface ScanOptions {
  root: string;
  files: FileSource;
  registry: Registry;
  formats: PlatformFormats;
  clock: Clock;
  logger?: Logger;
  classify?: ClassifyOptions;
  ignores?: IgnoreRule[];
  /** Report `legacy` entries as notices. */
  legacy?: boolean;
  /**
   * The platforms the repository uses. Entries on other platforms are dropped before
   * matching, so an ID shared across platforms gets the verdict of the platform in use.
   */
  platforms?: readonly Platform[] | null;
  /**
   * The platforms the repository's dependencies point to (`inferPlatforms`). Unlike `platforms`
   * they only settle IDs that several platforms serve: candidates on these platforms win, and the
   * others are kept when none of them is one.
   */
  preferredPlatforms?: readonly Platform[] | null;
  /**
   * Larger files are skipped and counted (default 1 MiB). For a notebook, this is the size of its
   * code cells' source, and the file may be up to 32 MiB.
   */
  maxFileSize?: number;
  /** Prefix of the inline directives: `sunset`. */
  directivePrefix?: string;
  detectors?: readonly Detector[];
  /** Milliseconds from some fixed point, for stage timings. Timings are 0 without it. */
  now?: () => number;
  /** How many files are read at once. */
  concurrency?: number;
}

interface FileOutcome {
  findings: Finding[];
  unresolved: UnresolvedReference[];
  mentions: Mention[];
  inventory: { modelId: string; location: Location }[];
  suppressed: Suppressed[];
  diagnostics: Diagnostic[];
  lines: number;
  lexed: boolean;
}

interface Context {
  matcher: Matcher;
  maxFileSize: number;
  detectors: readonly Detector[];
  today: IsoDate;
  legacy: boolean;
  ignores: CompiledIgnore[];
  prefix: string;
  preferred: readonly Platform[];
  suggest: Suggester;
  replacements: ReplacementCheck;
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? (() => 0);
  const started = now();
  const today = opts.clock.today();
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const classifier = createClassifier(opts.classify);
  const registry = onPlatforms(opts.registry, opts.platforms);
  const ctx: Context = {
    matcher: createMatcher(registry, opts.formats),
    maxFileSize,
    suggest: createSuggester(registry),
    detectors: opts.detectors ?? DEFAULT_DETECTORS,
    today,
    legacy: opts.legacy ?? false,
    ignores: compileIgnores(opts.ignores ?? [], today),
    prefix: opts.directivePrefix ?? DEFAULT_DIRECTIVE_PREFIX,
    preferred: opts.platforms ? [] : (opts.preferredPlatforms ?? []),
    // Replacements are checked on any platform, whichever the repository uses.
    replacements: createReplacementCheck(opts.registry, today),
  };

  const skipped: Record<SkipReason, number> = {
    excluded: 0,
    vendored: 0,
    generated: 0,
    binary: 0,
    'too-large': 0,
    'no-lexer': 0,
  };
  const queue: ClassifiedFile[] = [];
  let listed = 0;
  for await (const ref of opts.files.list(opts.root, { maxFileSize: readLimit(maxFileSize) })) {
    listed++;
    const file = classifier.classify(ref);
    const reason = skipReasonBefore(file, maxFileSize);
    if (reason) skipped[reason]++;
    else queue.push(file as ClassifiedFile);
  }
  const listedAt = now();

  const outcomes: FileOutcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const file = queue[next++] as ClassifiedFile;
      const text = await opts.files.read(file);
      const outcome = text === null ? 'binary' : scanFile(file, text, ctx);
      if (typeof outcome === 'string') skipped[outcome]++;
      else outcomes.push(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 16) }, worker));
  const scannedAt = now();

  const result = merge(outcomes);
  for (const ignore of ctx.ignores) {
    if (!ignore.expired) continue;
    const reason = ignore.rule.reason ? ` (${ignore.rule.reason})` : '';
    result.diagnostics.push({
      kind: 'expired-config-ignore',
      message: `Config ignore #${ignore.index + 1}${reason} expired on ${ignore.rule.until}; it no longer applies.`,
      location: null,
    });
  }

  const stats: ScanStats = {
    files: {
      listed,
      scanned: outcomes.length,
      lexed: outcomes.filter((o) => o.lexed).length,
      skipped,
    },
    lines: outcomes.reduce((sum, o) => sum + o.lines, 0),
    timings: { list: listedAt - started, scan: scannedAt - listedAt, total: now() - started },
  };
  const count = (n: number): string => n.toLocaleString('en-US');
  opts.logger?.debug(
    `scanned ${count(stats.files.scanned)} of ${count(listed)} files (${count(stats.files.lexed)} lexed) in ${count(Math.round(stats.timings.total))} ms`,
  );

  return {
    ...result,
    registry: {
      schemaVersion: opts.registry.schema_version,
      registryVersion: opts.registry.registry_version ?? null,
      entries: opts.registry.models.length,
      generatedAt: opts.registry.generated_at,
      newestCheck: newestCheck(opts.registry),
    },
    today,
    stats,
  };
}

function onPlatforms(
  registry: Registry,
  platforms: readonly Platform[] | null | undefined,
): Registry {
  if (!platforms) return registry;
  return { ...registry, models: registry.models.filter((e) => platforms.includes(e.platform)) };
}

function newestCheck(registry: Registry): IsoDate | null {
  let newest: IsoDate | null = null;
  for (const e of registry.models)
    if (newest === null || e.verified_on > newest) newest = e.verified_on;
  return newest;
}

/** The largest file a scan reads: notebooks may be larger than `maxFileSize`. */
export function readLimit(maxFileSize: number): number {
  return Math.max(maxFileSize, MAX_NOTEBOOK_SIZE);
}

function skipReasonBefore(file: ClassifiedFile | null, maxFileSize: number): SkipReason | null {
  if (!file) return 'excluded';
  if (file.class === 'vendored') return 'vendored';
  if (file.class === 'generated') return 'generated';
  if (file.class !== 'docs' && file.language === null) return 'no-lexer';
  // A notebook's code cells are measured once it's read (scanNotebook).
  if (file.size > (file.language === 'notebook' ? readLimit(maxFileSize) : maxFileSize)) {
    return 'too-large';
  }
  return null;
}

/** Runs every stage after reading on one file, or says why it's skipped after all. */
function scanFile(file: ClassifiedFile, rawText: string, ctx: Context): FileOutcome | SkipReason {
  // A byte-order mark would shift every column on the first line.
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  if (isGeneratedText(text)) return 'generated';
  const lines = new LineIndex(text);
  if (file.language === 'notebook') {
    const notebook = readNotebook(text);
    if (notebook) return scanNotebook(file, notebook, lines, ctx);
    // Not nbformat (a merge conflict, say): scanned as JSON, like any file of its size.
    if (file.size > ctx.maxFileSize) return 'too-large';
  }
  const language = file.class === 'docs' ? null : file.language;
  return scanText(file, text, lines, ctx, language && (() => lexerFor(language).lex(text)));
}

/**
 * Scans a notebook's cells: code cells as code in the kernel's language, markdown and raw cells as
 * docs (all of them in a docs notebook). Each kind is scanned as one text, and the locations found
 * are then moved to where that text is in the .ipynb file.
 */
function scanNotebook(
  file: ClassifiedFile,
  notebook: Notebook,
  lines: LineIndex,
  ctx: Context,
): FileOutcome | 'too-large' {
  const { cells, language } = notebook;
  const code = new CellText(
    lines.text,
    cells.filter((c) => c.code),
  );
  if (code.size() > ctx.maxFileSize) return 'too-large';
  const docs: ClassifiedFile = { ...file, class: 'docs', language: null };
  const prose = new CellText(
    lines.text,
    cells.filter((c) => !c.code),
  );
  const parts: { cells: CellText; file: ClassifiedFile; lex: (() => Spans) | null }[] =
    file.class === 'docs'
      ? [{ cells: new CellText(lines.text, cells), file: docs, lex: null }]
      : [
          { cells: code, file: { ...file, language }, lex: () => code.lex(cellLexer(language)) },
          { cells: prose, file: docs, lex: null },
        ];

  const outcome = emptyOutcome(lines.lineCount);
  for (const part of parts) {
    const partLines = new LineIndex(part.cells.text);
    const scanned = scanText(part.file, part.cells.text, partLines, ctx, part.lex);
    const offset = (line: number, column: number): number =>
      (partLines.starts[line - 1] as number) + column - 1;
    const move = (l: Location): Location => {
      const at = part.cells.toFile(offset(l.line, l.column), offset(l.endLine, l.endColumn));
      return lines.location(file.path, at.start, at.end);
    };
    const moved = <T extends { location: Location }>(item: T): T => ({
      ...item,
      location: move(item.location),
    });
    for (const f of scanned.findings) outcome.findings.push(moved(f));
    for (const u of scanned.unresolved) outcome.unresolved.push(moved(u));
    for (const m of scanned.mentions) outcome.mentions.push(moved(m));
    for (const i of scanned.inventory) outcome.inventory.push(moved(i));
    for (const s of scanned.suppressed) outcome.suppressed.push(moved(s));
    for (const d of scanned.diagnostics) {
      outcome.diagnostics.push({ ...d, location: d.location && move(d.location) });
    }
    outcome.lexed ||= scanned.lexed;
  }
  return outcome;
}

function emptyOutcome(lines: number): FileOutcome {
  return {
    findings: [],
    unresolved: [],
    mentions: [],
    inventory: [],
    suppressed: [],
    diagnostics: [],
    lines,
    lexed: false,
  };
}

/**
 * Scans `text` as `file`: prefilter, lexing (when `lex` is given), detectors and suppression.
 * Locations are in `text`, through `lines`.
 */
function scanText(
  file: ClassifiedFile,
  text: string,
  lines: LineIndex,
  ctx: Context,
  lex: (() => Spans) | null,
): FileOutcome {
  const outcome = emptyOutcome(lines.lineCount);
  const docs = file.class === 'docs';
  // Model-like strings outside the registry are worth lexing too: the inventory, and typos (model-id-unknown).
  if (!ctx.matcher.prefilter(text) && (docs || !hasModelLike(text))) return outcome;

  let spans: Spans = [];
  if (lex) {
    spans = lex();
    outcome.lexed = true;
  }
  const raw = dedupe(ctx.detectors.flatMap((d) => d.detect(file, text, spans, ctx.matcher)));

  const { directives, malformed } = docs
    ? { directives: [], malformed: [] }
    : parseDirectives(text, spans, lines, ctx.prefix);
  for (const m of malformed) {
    outcome.diagnostics.push({
      kind: 'malformed-directive',
      message: m.message,
      location: lines.location(file.path, m.start, m.end),
    });
  }
  for (const d of directives) {
    if (d.until === null || d.until >= ctx.today) continue;
    outcome.findings.push(expiredFinding(file, d, lines));
  }

  for (const r of raw) {
    const location = lines.location(file.path, r.start, r.end);
    switch (r.kind) {
      case 'inventory': {
        outcome.inventory.push({ modelId: r.text, location });
        const known = docs ? [] : ctx.suggest(r.text);
        if (known.length === 0) break;
        const rule = 'model-id-unknown';
        if (suppress(rule, location, [r.text], r.text, directives, ctx, outcome)) break;
        outcome.findings.push({
          rule,
          severity: 'notice',
          location,
          fileClass: file.class,
          modelId: r.text,
          context: null,
          entry: null,
          entries: [],
          retirementDate: null,
          daysLeft: null,
          message: unknownMessage(r.text, known),
        });
        break;
      }
      case 'reference':
        reference(file, r, location, directives, ctx, outcome);
        break;
      case 'unresolved': {
        const item: UnresolvedReference = {
          rule: 'model-reference-unresolved',
          severity: 'notice',
          location,
          fileClass: file.class,
          reason: r.reason,
          key: r.key,
          expression: r.expression,
          entries: r.entries,
          message: unresolvedMessage(r.reason, r.key, r.expression, r.entries, ctx.today),
        };
        const names = [r.expression, ...r.entries.flatMap(namesOf)];
        if (!suppress(item.rule, location, names, r.expression, directives, ctx, outcome)) {
          outcome.unresolved.push(item);
        }
        break;
      }
    }
  }
  return outcome;
}

function reference(
  file: ClassifiedFile,
  r: Extract<RawFinding, { kind: 'reference' }>,
  location: Location,
  directives: readonly Directive[],
  ctx: Context,
  outcome: FileOutcome,
): void {
  const { entries, judgedFor } = preferPlatforms(sortEntries(r.entries), ctx.preferred);
  const best = assessAll(entries, ctx.today, { legacy: ctx.legacy });
  if (!best) return;
  // A model router sends a slug to any provider that still serves the model, so the upstream
  // platform retiring it makes a router's slug a warning at most.
  const router = best.assessment.severity === 'error' ? routerOf(r.context) : null;
  const assessment: Assessment = router
    ? { ...best.assessment, severity: 'warning' }
    : best.assessment;
  const message = referenceMessage(r.text, best.entry, assessment, entries, r.context, {
    unaffected: best.unaffected,
    judgedFor,
    router,
    replacements: ctx.replacements,
  });
  const names = [r.text, ...entries.flatMap(namesOf)];

  if (file.class === 'docs') {
    // Mentions never fail and aren't annotated; config ignores by path or model still apply.
    if (suppress(assessment.rule, location, names, r.text, [], ctx, null)) return;
    outcome.mentions.push({
      location,
      modelId: r.text,
      entry: best.entry,
      entries,
      severity: assessment.severity,
      message,
    });
    return;
  }
  const { rule, severity, daysLeft } = assessment;
  if (suppress(rule, location, names, r.text, directives, ctx, outcome)) return;
  outcome.findings.push({
    rule,
    severity,
    location,
    fileClass: file.class,
    modelId: r.text,
    context: r.context,
    entry: best.entry,
    entries,
    retirementDate: best.entry.retirement_date,
    daysLeft,
    message,
  });
}

function suppress(
  rule: RuleId,
  location: Location,
  names: string[],
  modelId: string,
  directives: readonly Directive[],
  ctx: Context,
  outcome: FileOutcome | null,
): boolean {
  const item: Suppressible = { rule, path: location.path, line: location.line, names };
  const verdict = judge(item, directives, ctx.ignores, ctx.today);
  if (!verdict.suppressed) return false;
  outcome?.suppressed.push({
    rule,
    location,
    modelId,
    by: verdict.by,
    until: verdict.until,
    reason: verdict.reason,
  });
  return true;
}

function expiredFinding(file: ClassifiedFile, d: Directive, lines: LineIndex): Finding {
  return {
    rule: 'suppression-expired',
    severity: 'notice',
    location: lines.location(file.path, d.start, d.end),
    fileClass: file.class,
    modelId: d.text,
    context: null,
    entry: null,
    entries: [],
    retirementDate: null,
    daysLeft: null,
    message: `Suppression "${d.text}" expired on ${d.until}; what it covered is reported again. Remove it or extend the date.`,
  };
}

const namesOf = (e: RegistryEntry): string[] => [e.id, e.model_id, ...e.aliases];

/**
 * When the candidates span several platforms and some are on the preferred ones, keeps those.
 * `judgedFor` names the platforms kept, for the message; it's empty when nothing was dropped.
 */
function preferPlatforms(
  entries: RegistryEntry[],
  preferred: readonly Platform[],
): { entries: RegistryEntry[]; judgedFor: Platform[] } {
  const none = { entries, judgedFor: [] };
  if (preferred.length === 0) return none;
  const kept = entries.filter((e) => preferred.includes(e.platform));
  if (kept.length === 0 || kept.length === entries.length) return none;
  return { entries: kept, judgedFor: [...new Set(kept.map((e) => e.platform))] };
}

/** Entries in a stable order: by platform, then version, then region scope (unscoped last). */
function sortEntries(entries: readonly RegistryEntry[]): RegistryEntry[] {
  const key = (e: RegistryEntry): string =>
    `${e.platform}\u0000${e.version ?? ''}\u0000${e.regions?.length ? `0${e.regions.join(',')}` : '1'}\u0000${e.id}`;
  return [...entries].sort((a, b) => cmp(key(a), key(b)));
}

/**
 * When two detectors report the same text (an Azure model name is also a first-party ID), the
 * finding that claims it wins over references and inventory items there.
 */
function dedupe(raw: RawFinding[]): RawFinding[] {
  const claimed = new Set<number>();
  for (const r of raw) if (r.kind !== 'inventory' && r.claims) claimed.add(r.start);
  if (claimed.size === 0) return raw;
  return raw.filter(
    (r) => r.kind === 'unresolved' || (r.kind === 'reference' && r.claims) || !claimed.has(r.start),
  );
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Merged = Pick<
  ScanResult,
  'findings' | 'unresolved' | 'mentions' | 'inventory' | 'suppressed' | 'diagnostics'
>;

function merge(outcomes: FileOutcome[]): Merged {
  const byLocationThenRule = <T extends { location: Location; rule: string }>(a: T, b: T) =>
    compareLocations(a.location, b.location) || cmp(a.rule, b.rule);

  const inventory = new Map<string, Location[]>();
  for (const item of outcomes.flatMap((o) => o.inventory)) {
    const list = inventory.get(item.modelId) ?? [];
    list.push(item.location);
    inventory.set(item.modelId, list);
  }

  return {
    findings: outcomes.flatMap((o) => o.findings).sort(byLocationThenRule),
    unresolved: outcomes.flatMap((o) => o.unresolved).sort(byLocationThenRule),
    mentions: outcomes
      .flatMap((o) => o.mentions)
      .sort((a, b) => compareLocations(a.location, b.location) || cmp(a.modelId, b.modelId)),
    inventory: [...inventory]
      .sort(([a], [b]) => cmp(a, b))
      .map(
        ([modelId, locations]): InventoryItem => ({
          modelId,
          locations: locations.sort(compareLocations),
        }),
      ),
    suppressed: outcomes.flatMap((o) => o.suppressed).sort(byLocationThenRule),
    // Every diagnostic from a file has a location; config-level ones are appended afterwards.
    diagnostics: outcomes
      .flatMap((o) => o.diagnostics)
      .sort((a, b) => compareLocations(a.location as Location, b.location as Location)),
  };
}
