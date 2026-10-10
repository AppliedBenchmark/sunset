// The registry-literal detector: registry IDs inside string and config-value spans.
// IDs in comments are not references; comments are only read for suppression directives. In docs
// files every match counts, and the pipeline turns them into mentions.
//
// Some matches aren't references to a model, and are dropped:
// - a segment of a path or a URL, or a name after an unknown prefix (`contextOf`);
// - a single-word ID (`ada`, `davinci`) that isn't the whole value of a model parameter;
// - in code, an ID in a string with spaces in it (a sentence, a test name, an error message),
//   unless it is the value of a model key or a flag there (`"model": "gpt-4"`, `--model gpt-4`,
//   `-m gpt-4`) or a default (`| default "gpt-4"`, `|| 'gpt-4'`, `${MODEL:-gpt-4}`). A string
//   whose words are all IDs is a list, not a sentence: `"gpt-4 gpt-4o"`;
// - in code, the argument of a prefix or substring check: `startswith("gpt-4")`, `"o1" in model`;
// - an ID of letters and digits only (`o1`) inside a long base64 run.
import type { Detector, MatchHit } from '../ports.ts';
import { contextOf, findOpaqueArns, PREFIX_CHARACTER, platformsFor } from '../registry/formats.ts';
import type { RawFinding, ReferenceContext, RegistryEntry, Router, Span } from '../types.ts';
import { isModelKey } from './dynamic-detector.ts';
import { findModelLike } from './inventory.ts';
import { spanAt } from './lines.ts';

const isLiteral = (span: Span | null): span is Span => span !== null && span.kind !== 'comment';

/**
 * A registry ID that is a single word, such as OpenAI's `ada`, `curie` and `davinci` or Vertex's
 * `imagetext`, is also an ordinary word: a highlight.js language, a unit, a CSS class. It counts
 * only as the whole value of a model parameter (see `isModelValue`).
 */
const WORD = /^[A-Za-z]+$/;

/**
 * A key and an assignment right before a value, and the value's opening quote if it has one. A
 * quote may be escaped, as in JSON inside a string: `\"`, or `""` in a C# verbatim string.
 */
const KEY_BEFORE =
  /(?:^|[^A-Za-z0-9_$-])(\\?["'`]|""|)([A-Za-z_][A-Za-z0-9_-]{0,63})\1[ \t]*(?::=|=|:)[ \t]*(\\?["'`]|""|)$/;
/**
 * A command-line flag right before a value: `--model gpt-4o`, `--model_name=gpt-4o`, and `-m`,
 * the model flag of the `llm` and `openai` CLIs.
 */
const FLAG_BEFORE =
  /(?<![A-Za-z0-9_-])(?:--([A-Za-z][A-Za-z0-9_-]{0,63})(?:=|[ \t]+)|-m[ \t]+)(["']?)$/;
const VALUE_END = /[\s,;)}\]#&"'`\\]/;

/**
 * True when `text[start, end)` is the whole value of a model key or flag, possibly after a
 * library's prefix: `model="ada"`, `"engine": "davinci"`, `model: curie`, `--model gpt-4o`,
 * `"model": "openai/gpt-4o"`. The old completions API took the model as `engine`, which is where
 * the single-word IDs come from, so `engine` counts here although an unresolved `engine` doesn't.
 * Unless `word` is set, `-m` and any other long flag count too: `--fallback gpt-4o`.
 */
function isModelValue(text: string, start: number, end: number, word: boolean): boolean {
  if (isKeyedValue(text, start, end, word)) return true;
  let prefix = start;
  while (prefix > Math.max(0, start - 96) && PREFIX_CHARACTER.test(text[prefix - 1] as string)) {
    prefix--;
  }
  return prefix < start && isKeyedValue(text, prefix, end, word);
}

const isModelParameter = (key: string): boolean =>
  isModelKey(key) || key.toLowerCase() === 'engine';

function isKeyedValue(text: string, start: number, end: number, word: boolean): boolean {
  const before = text.slice(Math.max(0, start - 96), start);
  const assignment = KEY_BEFORE.exec(before);
  const flag = assignment ? null : FLAG_BEFORE.exec(before);
  if (assignment ? !isModelParameter(assignment[2] as string) : !flag) return false;
  // `-m` has no name; a single word only counts after a model flag.
  if (flag && word && (flag[1] === undefined || !isModelParameter(flag[1]))) return false;
  const quote = (assignment ? assignment[3] : flag?.[2]) ?? '';
  if (quote) return text.startsWith(quote, end);
  return end === text.length || VALUE_END.test(text[end] as string);
}

/**
 * A filter, function or operator that gives a default, right before a quoted value:
 * `| default "gpt-4o"` (Helm), `default('gpt-4o')` (Jinja), `|| 'gpt-4o'` (GitHub Actions),
 * `?? 'gpt-4o'`, `or 'gpt-4o'`.
 */
const DEFAULT_BEFORE = /(?:\bdefault[ \t]*\(?|\|\||\?\?|\bor)[ \t]*$/;
/**
 * A placeholder up to its default, which may have a library's prefix: Spring's `${key:`, the
 * shell's and Compose's `${NAME:-`, `${NAME-`, `${NAME:=` and `${NAME=`.
 */
const PLACEHOLDER_BEFORE =
  /\$\{(?:[A-Za-z0-9_.-]+:[-=]?|[A-Za-z_][A-Za-z0-9_]*[-=])(?:[A-Za-z0-9_.-]+[/:])*$/;

const TEMPLATE_END = /\}\}|%\}/;

/**
 * True when `text[start, end)` is a placeholder's default, `${MODEL:-gpt-4o}`, or a quoted default
 * in a `{{ … }}` or `{% … %}` expression: `{{ .Values.model | default "gpt-4o" }}`,
 * `${{ inputs.model || 'gpt-4o' }}`. Outside an expression, `the default 'gpt-4' model` and
 * `'gpt-4' or 'gpt-4o'` are prose.
 */
function isDefaultValue(text: string, start: number, end: number): boolean {
  if (text[end] === '}' && PLACEHOLDER_BEFORE.test(text.slice(Math.max(0, start - 96), start))) {
    return true;
  }
  let open = start;
  while (open > Math.max(0, start - 96) && PREFIX_CHARACTER.test(text[open - 1] as string)) open--;
  const quote = text[open - 1];
  if ((quote !== '"' && quote !== "'") || text[end] !== quote) return false;
  // Up to 200 characters of the line before the quote: a long line mustn't be read for every match.
  const before = text.slice(Math.max(0, open - 201), open - 1);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const expression = Math.max(line.lastIndexOf('{{'), line.lastIndexOf('{%'));
  return (
    expression !== -1 && !TEMPLATE_END.test(line.slice(expression)) && DEFAULT_BEFORE.test(line)
  );
}

/** A call that checks a prefix, a suffix or a substring, up to the argument at the end. */
const CHECK_CALL =
  /(?:\b(?:startswith|endswith|startsWith|endsWith|starts_with|ends_with|start_with\?|end_with\?|includes|include\?|contains|Contains|HasPrefix|HasSuffix|hasPrefix|hasSuffix|StartsWith|EndsWith|indexOf|lastIndexOf|str_starts_with|str_ends_with|str_contains|RegExp)|\bre\.(?:match|search|fullmatch|compile))\s*\(\s*[([]?\s*(?:[^()[\]]*,\s*)?$/;
/**
 * Python's and JavaScript's `in`, after the literal: `"ft:gpt-4" in model`. A key named `in`
 * (`in: query` in an OpenAPI parameter) isn't one.
 */
const IN_AFTER = /^\s*(?:not\s+)?in\b(?!\s*[:=])/;

/**
 * True when the literal from `open` (its opening quote or prefix) to `close` (after its closing
 * quote) is checked against a model name rather than naming one: `model.startswith("gpt-4")`,
 * `strings.HasPrefix(m, "o1")`, `"ft:gpt-4" in model`.
 */
function isCheckArgument(text: string, open: number, close: number): boolean {
  return (
    CHECK_CALL.test(text.slice(Math.max(0, open - 120), open)) ||
    IN_AFTER.test(text.slice(close, close + 16))
  );
}

/**
 * A router's own segment before `<vendor>/`: LiteLLM's `openrouter/anthropic/…` and
 * `vercel_ai_gateway/openai/…`, promptfoo's `openrouter:openai/…`.
 */
const ROUTE = /(?<![\w@.-])(?:openrouter[/:]|vercel_ai_gateway\/)[A-Za-z0-9][\w.-]*\//;
/** OpenRouter's name, also in its URL, `OPENROUTER_API_KEY` and `@openrouter/ai-sdk-provider`. */
const OPENROUTER = /openrouter/i;
/**
 * The Vercel AI Gateway: the AI SDK (`from 'ai'`, `require('ai')`), which sends a `<vendor>/<id>`
 * string to the Gateway by default; the Gateway's provider package, its URL and its API key.
 */
const AI_GATEWAY =
  /\bfrom\s*['"]ai['"]|\brequire\(\s*['"]ai['"]\s*\)|@ai-sdk\/gateway|ai-gateway\.vercel\.sh|\bAI_GATEWAY_API_KEY\b/;

/**
 * The router that a `<vendor>/<id>` without a router's segment goes through in `text`. A file
 * that writes a router's segment itself calls vendors directly with `<vendor>/`. Otherwise a file
 * that mentions OpenRouter uses OpenRouter, and then one that uses the Vercel AI Gateway the
 * Gateway.
 */
function routerIn(text: string): Router | null {
  if (ROUTE.test(text)) return null;
  if (OPENROUTER.test(text)) return 'openrouter';
  return AI_GATEWAY.test(text) ? 'vercel-ai-gateway' : null;
}

/** The words of a list of IDs: what whitespace and commas separate. */
const LIST_WORD = /[^\s,]+/g;
const QUOTE = /["'`]/;

/** The index of the first hit that starts at or after `p`. */
function firstHitFrom(hits: readonly MatchHit[], p: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((hits[mid] as MatchHit).start < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const BASE64_CHARACTER = /[A-Za-z0-9+/]/;
/** Base64 payloads and data URIs run far longer; text around a lone `+` or `/` doesn't. */
const BASE64_RUN = 40;

/**
 * True when an ID of letters and digits (`o1`) sits in a run of at least BASE64_RUN base64
 * characters, such as `…+o1/…` in an embedded image. An ID with `-`, `.` or `:` can't be in one.
 */
function inBase64(text: string, start: number, end: number): boolean {
  if (!/^[A-Za-z0-9]+$/.test(text.slice(start, end))) return false;
  let run = end - start;
  for (let i = start - 1; i >= 0 && run < BASE64_RUN; i--, run++) {
    if (!BASE64_CHARACTER.test(text[i] as string)) break;
  }
  for (let i = end; i < text.length && run < BASE64_RUN; i++, run++) {
    if (!BASE64_CHARACTER.test(text[i] as string)) break;
  }
  return run >= BASE64_RUN;
}

export const literalDetector: Detector = {
  id: 'literal',
  detect(file, text, spans, matcher) {
    const docs = file.class === 'docs';
    const out: RawFinding[] = [];
    // Registry IDs in literals, reported or not: the inventory leaves them out.
    const covered: { start: number; end: number }[] = [];
    let routes: Router | null | undefined;
    const router = (): Router | null => {
      if (routes === undefined) routes = routerIn(text);
      return routes;
    };
    const hits = matcher.find(text);
    const contexts: (ReferenceContext | null | undefined)[] = [];
    const contextAt = (k: number): ReferenceContext | null => {
      let context = contexts[k];
      if (context === undefined) {
        const { start, end, form } = hits[k] as MatchHit;
        context = contextOf(text, start, end, matcher.lookup(form), matcher.formats, router);
        contexts[k] = context;
      }
      return context;
    };
    // True when every word of the span is an ID the scan reads, maybe after a prefix and in quotes.
    const isList = (span: Span): boolean => {
      let k = firstHitFrom(hits, span.start);
      for (const word of text.slice(span.start, span.end).matchAll(LIST_WORD)) {
        let start = span.start + word.index;
        let end = start + word[0].length;
        while (start < end && QUOTE.test(text[start] as string)) start++;
        while (end > start && QUOTE.test(text[end - 1] as string)) end--;
        if (start === end) continue;
        while (k < hits.length && (hits[k] as MatchHit).end < end) k++;
        const hit = hits[k];
        if (!hit || hit.end !== end || hit.start < start) return false;
        for (let i = start; i < hit.start; i++) {
          if (!PREFIX_CHARACTER.test(text[i] as string)) return false;
        }
        if (!contextAt(k)) return false;
        k++;
      }
      return true;
    };
    const sentences = new Map<Span, boolean>();
    const isSentence = (span: Span): boolean => {
      let words = sentences.get(span);
      if (words === undefined) {
        words = /\S\s+\S/.test(text.slice(span.start, span.end)) && !isList(span);
        sentences.set(span, words);
      }
      return words;
    };

    for (let k = 0; k < hits.length; k++) {
      const hit = hits[k] as MatchHit;
      const span = docs ? null : spanAt(spans, hit.start, hit.end);
      if (!docs && !isLiteral(span)) continue;
      covered.push(hit);
      const forms = matcher.lookup(hit.form);
      const context = contextAt(k);
      if (!context || inBase64(text, hit.start, hit.end)) continue;
      if (WORD.test(hit.form)) {
        if (!isModelValue(text, hit.start, hit.end, true)) continue;
      } else if (
        span &&
        isSentence(span) &&
        !isModelValue(text, hit.start, hit.end, false) &&
        !isDefaultValue(text, hit.start, hit.end)
      ) {
        continue;
      }
      if (
        span &&
        isCheckArgument(text, span.open ?? span.start, span.end + (span.open === undefined ? 0 : 1))
      ) {
        continue;
      }
      const allowed = platformsFor(context, matcher.formats);
      const entries: RegistryEntry[] = [];
      for (const form of forms) {
        if (allowed && !allowed.includes(form.entry.platform)) continue;
        if (!entries.includes(form.entry)) entries.push(form.entry);
      }
      if (entries.length === 0) continue;
      out.push({
        kind: 'reference',
        start: hit.start,
        end: hit.end,
        text: hit.form,
        context,
        entries,
      });
    }
    if (docs) return out;

    for (const arn of findOpaqueArns(text)) {
      if (!isLiteral(spanAt(spans, arn.start, arn.end))) continue;
      out.push({
        kind: 'unresolved',
        start: arn.start,
        end: arn.end,
        reason: 'opaque-arn',
        key: null,
        expression: text.slice(arn.start, arn.end),
        entries: [],
      });
    }

    // Inventory: model-like strings in literals that aren't registry IDs.
    let r = 0;
    for (const item of findModelLike(text, 0, text.length, matcher.formats)) {
      if (!isLiteral(spanAt(spans, item.start, item.end))) continue;
      while (r < covered.length && (covered[r] as { end: number }).end <= item.start) r++;
      const hit = covered[r];
      if (hit && hit.start < item.end) continue;
      out.push({ kind: 'inventory', ...item });
    }
    return out;
  },
};
