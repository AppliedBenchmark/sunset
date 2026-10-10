// The dynamic-reference detector: a model-like key assigned from a value
// Sunset can't read (an identifier, an environment lookup, an interpolated string) becomes an
// `unresolved` notice instead of being skipped silently.
//
// Precision rules, so that ordinary code doesn't drown the report:
// - Properties and keyword arguments (`model: x`, `create(model=x)`) are reported for any
//   non-literal value; type annotations (`model: str`, `model: ModelId`) are not values.
// - Plain assignments (`model = x`, `self.model = x`) are reported only for environment lookups
//   and interpolated strings: `model = model.to(device)` is a variable, not a model ID.
// - Values that can't be model IDs (numbers, booleans, objects, constructors, functions) are skipped.
// - A call with a model ID as its first argument, `openai('gpt-4o')`, is checked as that literal.
// - A value that is just the key's name (`model=model`) passes a model on; where it comes from is
//   reported where it's set.
import type { Detector, Matcher } from '../ports.ts';
import type {
  ClassifiedFile,
  Language,
  RawFinding,
  Span,
  Spans,
  UnresolvedReason,
} from '../types.ts';
import { hasModelLike } from './inventory.ts';
import { spanAt } from './lines.ts';

// Bounded, and never starting after a `-`: an unbounded key re-read the rest of a long
// `a-b-c-…` chain from every `-` in it, which took minutes on a 1 MiB file.
const KEY = `[A-Za-z_][A-Za-z0-9_]{0,63}(?:-[A-Za-z0-9_]{1,63}){0,7}`;
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$-])(["'\x60]?)(${KEY})\1[ \t]*(:=|=|:)(?![=>:])`,
  'g',
);
const FLAG = /(?<![\w-])--(model|model-name|model-id|deployment|deployment-name)(?:=|[ \t]+)/g;
/** The `$X`, `${X}` or `${{ x }}` right after a flag; `y`, so it's read in place. */
const FLAG_VALUE = /\$\{\{[^}\n]*\}\}|\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/y;

/**
 * Words that may qualify `deployment` in a key (`azure_deployment`, `chatDeploymentName`). Any
 * other qualifier means some other kind of deployment (`githubDeploymentId`, `k8s_deployment`).
 */
const AI_DEPLOYMENT = new Set([
  'azure',
  'openai',
  'aoai',
  'ai',
  'llm',
  'model',
  'gpt',
  'chat',
  'completion',
  'completions',
  'embedding',
  'embeddings',
  'default',
]);

/**
 * Words that mark a key as something other than a provider's model ID: `view_model` and
 * `response_model`, and Bedrock's `customModelName` and `provisionedModelId`, which name a model you
 * trained or bought throughput for.
 */
const NOT_AI = new Set([
  'custom',
  'provisioned',
  'view',
  'data',
  'base',
  'db',
  'orm',
  'schema',
  'response',
  'request',
  'table',
  'entity',
  'domain',
  'form',
  'parent',
  'related',
  'through',
  'serializer',
  'document',
]);

export function isModelKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
  if (words.some((w) => NOT_AI.has(w))) return false;
  const last = words[words.length - 1];
  const at = last === 'id' || last === 'name' ? words.length - 2 : words.length - 1;
  const head = words[at];
  if (head === 'model') return true;
  return head === 'deployment' && words.slice(0, at).every((w) => AI_DEPLOYMENT.has(w));
}

const CONFIG_ONLY: ReadonlySet<Language | null> = new Set(['yaml', 'json', 'toml', 'ini']);
const DOLLAR_LANGUAGES: ReadonlySet<Language | null> = new Set([...CONFIG_ONLY, 'shell']);

/** Values that can't hold a model ID, or that build objects rather than IDs. */
const NOT_AN_ID =
  /^(?:-?[0-9]|true\b|false\b|True\b|False\b|null\b|None\b|nil\b|undefined\b|[[{(<]|function\b|lambda\b|def\b|class\b|new\b|async\b|typeof\b|keyof\b|[A-Z][A-Za-z0-9_]*\s*[({<]|(?:[A-Za-z_][\w]*\.)+[A-Z][A-Za-z0-9_]*\s*\()/;

/**
 * Schema and column builders describe a field rather than set it: `model: z.string()` (zod,
 * valibot, yup, Joi, io-ts, TypeBox), `model: text("model").notNull()` (Drizzle, Knex).
 */
const SCHEMA_BUILDER =
  /^(?:(?:z|v|yup|Joi|t|Type|s)\.[A-Za-z]+\(|(?:text|varchar|char|string|uuid|json|jsonb|enum|pgEnum|mysqlEnum|column)\()/;

/** Type annotations after `:` in code. */
const TYPE_ANNOTATION =
  /^(?:[A-Z](?=[A-Za-z0-9_]*[a-z])[A-Za-z0-9_]*(?:\[.*\]|<.*>)?(?:\s*\|.*)?\s*$|(?:str|string|int|any|unknown|bool|boolean|number|object|float|bytes|dict|list|type|Type|Optional|Literal|Union)\b)/;

/** Terraform type constraints, as in a variable's `object({ model_name = string })`. */
export const HCL_TYPE =
  /^(?:(?:string|number|bool|any)\b|(?:optional|list|set|map|object|tuple)\s*\()/;

const ENVIRONMENT =
  /(?:\bprocess\.env\b|\bimport\.meta\.env\b|\bos\.environ\b|\bos\.getenv\b|\bgetenv\(|\bSystem\.getenv\b|\bEnvironment\.GetEnvironmentVariable\b|\bos\.Getenv\b|\benv::var\b|\bENV\[|\bENV\.fetch\b|\bDeno\.env\b|\bBun\.env\b|\$\{\{\s*(?:env|vars|secrets|inputs)\.|^\$\{?[A-Za-z_][A-Za-z0-9_]*(?::?[-=?+][^}]*)?\}?$)/;

const MAX_EXPRESSION = 80;

const DOLLAR = /\$\{?\{?\s*[A-Za-z_]/;

/** `environment` when a literal is just an environment lookup, such as `"${MODEL:-x}"`. */
function dollarReason(expression: string): UnresolvedReason {
  const unquoted = expression.replace(/^(["'`])([\s\S]*)\1$/, '$2').trim();
  return ENVIRONMENT.test(unquoted) ? 'environment' : 'interpolated';
}

/** The value expression starting at `p`, up to a delimiter at bracket depth 0 or the line end. */
function readExpression(text: string, p: number, spans: Spans): string {
  let depth = 0;
  let i = p;
  while (i < text.length && i - p < 200) {
    const span = spanAt(spans, i);
    if (span && span.kind !== 'comment' && span.start === i && span.end > i) {
      i = span.end;
      continue;
    }
    const c = text[i] as string;
    if (c === '\n' || (span?.kind === 'comment' && span.start === i)) break;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) break;
    i++;
  }
  const expression = text.slice(p, i).trim().replace(/\s+/g, ' ');
  return expression.length > MAX_EXPRESSION
    ? `${expression.slice(0, MAX_EXPRESSION - 1)}…`
    : expression;
}

/** After a type at `p`, where the default value starts (`str = <default>`), or null. */
function defaultAfter(text: string, spans: Spans, p: number): number | null {
  let depth = 0;
  for (let i = p; i < text.length && i - p < 200; i++) {
    const span = spanAt(spans, i);
    if (span && span.start === i && span.end > i) {
      if (span.kind === 'comment') return null;
      i = span.end - 1;
      continue;
    }
    const c = text[i] as string;
    if (c === '\n') return null;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return null;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';')) return null;
    else if (
      depth === 0 &&
      c === '=' &&
      !/[=!<>]/.test(text[i - 1] ?? '') &&
      !/[=>]/.test(text[i + 1] ?? '')
    ) {
      let value = i + 1;
      while (text[value] === ' ' || text[value] === '\t') value++;
      return value;
    }
  }
  return null;
}

/** The innermost open bracket at each position (outside strings and comments), or ''. */
function innermostBrackets(text: string, spans: Spans, positions: number[]): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let s = 0;
  let i = 0;
  for (const pos of positions) {
    while (i < pos) {
      const span = spans[s];
      if (span && i >= span.start) {
        if (i < span.end) i = span.end;
        s++;
        continue;
      }
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') stack.push(c);
      else if (c === ')' || c === ']' || c === '}') stack.pop();
      i++;
    }
    out.push(stack[stack.length - 1] ?? '');
  }
  return out;
}

function unresolved(
  start: number,
  end: number,
  reason: UnresolvedReason,
  key: string,
  expression: string,
): RawFinding {
  return { kind: 'unresolved', start, end, reason, key, expression, entries: [] };
}

/** The index of the first span starting at or after `p`. */
function firstSpanFrom(spans: Spans, p: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((spans[mid] as Span).start < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A literal value at `p`: a string span opening there, or a config value starting there. */
function literalAt(spans: Spans, p: number): Span | null {
  const span = spans[firstSpanFrom(spans, p)];
  if (!span || span.kind === 'comment') return null;
  if (span.open === p || (span.open === undefined && span.start === p)) return span;
  return null;
}

/** Text of a whole (possibly interpolated) literal that opens at `open`. */
function literalText(text: string, spans: Spans, first: Span): string {
  let end = first.end;
  for (let i = firstSpanFrom(spans, first.start); i < spans.length; i++) {
    const span = spans[i] as Span;
    if (span.start > end + 200) break;
    if (span.open === first.open && span.end > end) end = span.end;
  }
  const raw = text.slice(first.open ?? first.start, Math.min(end + 1, text.length));
  return raw.length > MAX_EXPRESSION ? `${raw.slice(0, MAX_EXPRESSION - 1)}…` : raw;
}

/** A call up to its first argument: `openai(`, `registry.languageModel(`. */
const CALL = /[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*[ \t]*\([ \t]*/y;

/** Shaped like a model ID: letters and digits joined by `-`, `.`, `/`, `:` or `@`, with a digit. */
const ID_SHAPED = /^(?=[^\d]*\d)[A-Za-z0-9]+(?:[-./:@][A-Za-z0-9]+)*$/;

/**
 * True when the value at `p` is a call whose first argument is a plain string literal naming a
 * model, as in the AI SDK's `openai('gpt-4o-mini')` or `groq('llama-3.3-70b')`. That string is
 * read like any other literal; a lookup key (`settings.get("model")`) has no version number.
 */
function callsWithModel(scope: Scope, p: number): boolean {
  CALL.lastIndex = p;
  const call = CALL.exec(scope.text);
  if (!call) return false;
  const literal = literalAt(scope.spans, p + call[0].length);
  if (literal?.kind !== 'string' || literal.interpolated) return false;
  const value = scope.text.slice(literal.start, literal.end);
  return scope.matcher.find(value).length > 0 || hasModelLike(value) || ID_SHAPED.test(value);
}

/** What `classifyValue` needs about the file. */
interface Scope {
  file: ClassifiedFile;
  text: string;
  spans: Spans;
  matcher: Matcher;
  /** Names the file assigns a plain string literal, computed when first needed. */
  constants: () => ReadonlySet<string>;
}

function classifyValue(
  scope: Scope,
  p: number,
  operator: string,
  bracket: string,
): { reason: UnresolvedReason; expression: string; end: number } | null {
  const { file, text, spans } = scope;
  const c = text[p];
  if (c === undefined || c === '\n' || c === '\r') return null;

  const literal = literalAt(spans, p);
  if (literal) {
    // Strings in code interpolate when the lexer says so. Config values and strings interpolate
    // when they hold `${MODEL}`, `$MODEL` or `${{ vars.X }}` (Compose, Actions, `.env`).
    const dollar =
      (literal.kind === 'value' || DOLLAR_LANGUAGES.has(file.language)) &&
      DOLLAR.test(text.slice(literal.start, literal.end));
    if (!literal.interpolated && !dollar) return null;
    const expression =
      literal.kind === 'value'
        ? text.slice(literal.start, literal.end).trim()
        : literalText(text, spans, literal);
    return { reason: dollarReason(expression), expression, end: literal.end };
  }
  const span = spanAt(spans, p);
  if (span?.kind === 'comment') return null;
  if (span) {
    // Inside a literal that started earlier, such as the shell word `MODEL=$X` or a heredoc line:
    // the value is the rest of it, and only a `$` reference makes it dynamic.
    const eol = text.indexOf('\n', p);
    const rest = text.slice(p, Math.min(span.end, eol === -1 ? text.length : eol)).trim();
    if (!/^["']?\$\{?\{?\s*[A-Za-z_]/.test(rest)) return null;
    return { reason: dollarReason(rest), expression: rest, end: p + rest.length };
  }
  if (CONFIG_ONLY.has(file.language)) return null;

  const expression = readExpression(text, p, spans);
  if (!expression) return null;
  if (operator === ':' && TYPE_ANNOTATION.test(expression)) {
    // A type, not a value. A parameter's default may follow it, `model: str = os.environ["M"]`,
    // except after a class type (`type[BaseModel]`), whose values are classes.
    const value = /^[Tt]ype\[/.test(expression) ? null : defaultAfter(text, spans, p);
    return value === null ? null : classifyValue(scope, value, '=', bracket);
  }
  const environment = ENVIRONMENT.test(expression);
  if (
    !environment &&
    (NOT_AN_ID.test(expression) || SCHEMA_BUILDER.test(expression) || callsWithModel(scope, p))
  ) {
    return null;
  }
  const reason: UnresolvedReason = environment ? 'environment' : 'variable';
  const end = p + Math.min(expression.length, text.length - p);

  // A constant defined in the same file as a plain string: the literal detector already reports
  // it where it's defined (`const LLM_MODEL = 'claude-…'` … `{ model: LLM_MODEL }`).
  if (!environment && IDENTIFIER.test(expression) && scope.constants().has(expression)) {
    return null;
  }

  // HCL uses `=`; a `:` in code is a property or a dict entry.
  if (operator === ':') return { reason, expression, end };
  // `=` or `:=`: a keyword argument inside a call, or a plain assignment.
  if (file.language === 'hcl')
    return HCL_TYPE.test(expression) ? null : { reason, expression, end };
  if (bracket === '(') return { reason, expression, end };
  return environment ? { reason, expression, end } : null;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Declaration words that may start a statement before the name. */
const DECLARATION =
  '(?:(?:export|const|let|var|val|final|static|public|private|protected|internal|readonly)[ \\t]+)*';

const CONSTANT = new RegExp(
  String.raw`^[ \t]*${DECLARATION}([A-Za-z_$][A-Za-z0-9_$]*)[ \t]*(?::[ \t]*[A-Za-z_][\w.<>\[\]| ]*)?[ \t]*:?=[ \t]*(?=["'\x60])`,
  'dgm',
);

/**
 * The names that a statement in the file assigns a plain, non-interpolated string literal:
 * `NAME = "x"`, `const NAME: string = 'x'`, `NAME := "x"`, `val NAME = "x"`. Parameters with
 * defaults (`def f(model: str = "x")`) and properties (`a.NAME = …`) don't count: they can hold
 * anything. One pass over the file, however many values refer to a name.
 */
function constantNames(text: string, spans: Spans): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(CONSTANT)) {
    const name = m[1] as string;
    if (spanAt(spans, m.indices?.[1]?.[0] ?? m.index)) continue;
    const literal = literalAt(spans, m.index + m[0].length);
    if (literal && literal.kind === 'string' && !literal.interpolated) names.add(name);
  }
  return names;
}

export const dynamicDetector: Detector = {
  id: 'dynamic',
  detect(file, text, spans, matcher) {
    if (file.class === 'docs') return [];
    const out: RawFinding[] = [];
    const candidates: { keyStart: number; key: string; operator: string; valueStart: number }[] =
      [];

    for (const m of text.matchAll(ASSIGNMENT)) {
      const quote = m[1] as string;
      const key = m[2] as string;
      if (!isModelKey(key)) continue;
      const keyStart = m.index + quote.length;
      const keyEnd = keyStart + key.length;
      const span = spanAt(spans, keyStart, keyEnd);
      if (span) {
        if (span.kind === 'comment') continue;
        // Inside a literal, only a quoted key or a config key counts: not `"set model = x"`.
        const exact = span.start === keyStart && (span.end === keyEnd || span.kind === 'value');
        if (!exact) continue;
      } else if (quote) continue;
      // `cond ? model : other` is a conditional, not a property.
      if (/\?\s*$/.test(text.slice(Math.max(0, keyStart - 8), keyStart))) continue;
      // Shell has no `key: value`; `${MODEL:-x}` is a default, not a property.
      if (file.language === 'shell' && m[3] !== '=') continue;
      let p = m.index + m[0].length;
      while (text[p] === ' ' || text[p] === '\t') p++;
      candidates.push({ keyStart, key, operator: m[3] as string, valueStart: p });
    }

    const brackets = innermostBrackets(
      text,
      spans,
      candidates.map((c) => c.keyStart),
    );
    let constants: Set<string> | null = null;
    const scope: Scope = {
      file,
      text,
      spans,
      matcher,
      constants: () => (constants ??= constantNames(text, spans)),
    };
    candidates.forEach((candidate, k) => {
      const value = classifyValue(
        scope,
        candidate.valueStart,
        candidate.operator,
        brackets[k] ?? '',
      );
      if (!value || value.expression === candidate.key) return;
      out.push(
        unresolved(candidate.keyStart, value.end, value.reason, candidate.key, value.expression),
      );
    });

    // Command-line flags in scripts and workflow files: `--model "$MODEL"`.
    if (file.language === 'shell' || file.language === 'yaml') {
      // The Azure detector reads `az cognitiveservices` commands; checked once per line.
      let lineEnd = -1;
      let azLine = false;
      for (const m of text.matchAll(FLAG)) {
        const span = spanAt(spans, m.index);
        if (span?.kind === 'comment') continue;
        if (m.index > lineEnd) {
          const lineStart = text.lastIndexOf('\n', m.index) + 1;
          lineEnd = text.indexOf('\n', m.index);
          if (lineEnd === -1) lineEnd = text.length;
          azLine = /\baz\s+cognitiveservices\b/.test(text.slice(lineStart, lineEnd));
        }
        if (azLine) continue;
        let p = m.index + m[0].length;
        if (text[p] === '"' || text[p] === "'") p++;
        FLAG_VALUE.lastIndex = p;
        const word = FLAG_VALUE.exec(text);
        if (!word) continue;
        const reason = ENVIRONMENT.test(word[0]) ? 'environment' : 'interpolated';
        out.push(unresolved(m.index, p + word[0].length, reason, `--${m[1]}`, word[0]));
      }
    }
    return out;
  },
};
