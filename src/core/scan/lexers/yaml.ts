// The YAML lexer: comments; plain, quoted and block scalars become config values. Keys
// are scalars too, so they are reported as values (a model ID used as a mapping key is a reference).
// A value under a key that holds commands (`run: |`, `command:`) is lexed as shell, so that each
// word is its own value, as in a script.
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';
import { isBlank, lexPart } from './engine.ts';
import { shellLexer } from './hash.ts';

/** A blank, or the end of the text. */
const isBlankOrEnd = (c: string | undefined): boolean => c === undefined || isBlank(c);

const FLOW = '[]{},';

/**
 * Keys whose values are commands: `run` (GitHub Actions, CircleCI); `script` (GitLab CI, Bitbucket,
 * Azure Pipelines), with GitLab's `before_script` and `after_script`; `command`, `entrypoint` and
 * `args` (Compose, Kubernetes, Docker container actions); `commands` (Drone, Buildkite, CodeBuild);
 * `cmd` and `cmds` (Taskfile); `entry` (pre-commit); and `inlineScript` (the Azure CLI task).
 */
const COMMAND_KEYS: ReadonlySet<string> = new Set([
  'run',
  'script',
  'before_script',
  'after_script',
  'command',
  'commands',
  'entrypoint',
  'args',
  'cmd',
  'cmds',
  'entry',
  'inlineScript',
]);

interface Key {
  column: number;
  name: string;
}

interface Flow {
  mapping: boolean;
  /** The key that the collection's values belong to. */
  key: string | null;
}

function lexYaml(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  let i = 0;
  let lineStart = 0;
  // Whether the line's first token is still to come.
  let fresh = true;
  // The column of the last `- ` entry or key on the line: a block scalar is indented more than it.
  let parent = 0;
  // The block mapping keys around the current position, innermost last.
  const keys: Key[] = [];
  // The open flow collections, innermost last.
  const flows: Flow[] = [];

  const lineEnd = (from: number): number => {
    const j = text.indexOf('\n', from);
    return j === -1 ? n : j;
  };

  /** The key that the value at the current position belongs to. */
  const owner = (): string =>
    (flows.length > 0 ? (flows[flows.length - 1] as Flow).key : keys[keys.length - 1]?.name) ?? '';

  /**
   * A scalar starting at `open` (its quote, if it has one) with content `[start, end)`, and `after`
   * the offset after it: a key if a `:` follows, otherwise a value.
   */
  const scalar = (open: number, start: number, end: number, after: number): void => {
    let k = after;
    while (text[k] === ' ' || text[k] === '\t') k++;
    if (text[k] === ':' && (flows.length > 0 || isBlankOrEnd(text[k + 1]))) {
      const name = text.slice(start, end);
      const flow = flows[flows.length - 1];
      if (flow?.mapping) flow.key = name;
      else if (!flow) {
        const column = open - lineStart;
        while (keys.length > 0 && (keys[keys.length - 1] as Key).column >= column) keys.pop();
        keys.push({ column, name });
        parent = column;
      }
    } else if (COMMAND_KEYS.has(owner())) {
      lexPart(shellLexer, text, start, end, out);
      return;
    }
    if (open < start) out.push({ start, end, kind: 'string', open });
    else if (end > start) out.push({ start, end, kind: 'value' });
  };

  while (i < n) {
    const c = text[i] as string;
    // The innermost flow collection, if the position is in one.
    const flow = flows[flows.length - 1];
    if (c === '\n') {
      i++;
      lineStart = i;
      fresh = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#' && (i === 0 || isBlank(text[i - 1]))) {
      const end = lineEnd(i);
      out.push({ start: i, end, kind: 'comment' });
      i = end;
      continue;
    }
    if (fresh) {
      fresh = false;
      parent = i - lineStart;
      // The keys this line is inside of are indented less, but a `- ` entry may be indented as much.
      const entry = c === '-' && isBlankOrEnd(text[i + 1]);
      while (!flow && keys.length > 0) {
        const column = (keys[keys.length - 1] as Key).column;
        if (column < parent || (column === parent && entry)) break;
        keys.pop();
      }
    }
    if (i === lineStart && (c === '%' || text.startsWith('---', i) || text.startsWith('...', i))) {
      if (c === '%' || isBlankOrEnd(text[i + 3])) {
        i = c === '%' ? lineEnd(i) : i + 3;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const close = closingQuote(text, i);
      scalar(i, i + 1, close, close + 1);
      i = Math.min(close + 1, n);
      continue;
    }
    if (c === '[' || c === '{') {
      flows.push({ mapping: c === '{', key: c === '[' ? owner() : null });
      i++;
      continue;
    }
    if (c === ']' || c === '}') {
      flows.pop();
      i++;
      continue;
    }
    if (c === ',' && flow) {
      if (flow.mapping) flow.key = null;
      i++;
      continue;
    }
    if ((c === '-' || c === '?' || c === ':') && isBlankOrEnd(text[i + 1])) {
      if (c === '-' && !flow) parent = i - lineStart;
      i++;
      continue;
    }
    if (c === ':' && flow && FLOW.includes(text[i + 1] ?? '')) {
      i++;
      continue;
    }
    if (c === '&' || c === '*' || c === '!') {
      while (i < n && !isBlank(text[i]) && !(flow && FLOW.includes(text[i] as string))) i++;
      continue;
    }
    if ((c === '|' || c === '>') && !flow) {
      const header = /^[|>][-+0-9]*[ \t]*(#.*)?$/.exec(
        text.slice(i, lineEnd(i)).replace(/\r$/, ''),
      );
      if (header) {
        i = blockScalar(text, i, parent, COMMAND_KEYS.has(owner()), out);
        lineStart = i;
        fresh = true;
        continue;
      }
    }
    const end = plainEnd(text, i, flow !== undefined);
    scalar(i, i, end.content, end.next);
    i = end.next === i ? i + 1 : end.next;
  }
  return out;
}

/**
 * The closing quote of the quoted scalar at `i`, or the end of the text. `"` uses backslash escapes,
 * `'` doubles the quote. Both may span lines.
 */
function closingQuote(text: string, i: number): number {
  const q = text[i];
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    if (q === '"' && text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text[j] === q) {
      if (q === "'" && text[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j;
    }
    j++;
  }
  return n;
}

/**
 * A plain scalar at `i`, which ends at `: `, ` #`, the end of the line, or a flow indicator: where
 * its content ends, trailing blanks aside, and where the scan stopped.
 */
function plainEnd(text: string, i: number, flow: boolean): { content: number; next: number } {
  const n = text.length;
  let j = i;
  while (j < n) {
    const c = text[j] as string;
    if (c === '\n') break;
    if (c === ':' && (isBlankOrEnd(text[j + 1]) || (flow && FLOW.includes(text[j + 1] ?? '')))) {
      break;
    }
    if (c === '#' && isBlankOrEnd(text[j - 1])) break;
    if (flow && FLOW.includes(c)) break;
    j++;
  }
  let end = j;
  while (end > i && isBlank(text[end - 1])) end--;
  return { content: end, next: j };
}

/**
 * A block scalar (`|` or `>`): every following line that is blank or indented more than its parent
 * node. Returns where its last line ends.
 *
 * Its lines are one value, except lines starting with `#`: to YAML they are content, but the
 * scripts and configs that block scalars hold (`run: |`) read them as comments, and directives in
 * them have to work. Under a key that holds commands, it is a script, lexed as shell.
 */
function blockScalar(
  text: string,
  i: number,
  parentIndent: number,
  command: boolean,
  out: Span[],
): number {
  const n = text.length;
  const headerEnd = text.indexOf('\n', i);
  if (headerEnd === -1) return n;
  const start = headerEnd + 1;
  // The lines that aren't blank: where each starts, its indentation, and where it ends.
  const lines: { start: number; indent: number; end: number }[] = [];
  for (let j = start; j < n; ) {
    const eol = text.indexOf('\n', j);
    const end = eol === -1 ? n : eol;
    if (text.slice(j, end).trim() !== '') {
      let indent = 0;
      while (text[j + indent] === ' ') indent++;
      if (indent <= parentIndent) break;
      lines.push({ start: j, indent, end });
    }
    j = eol === -1 ? n : eol + 1;
  }
  const end = lines[lines.length - 1]?.end ?? start;
  if (command) {
    lexPart(shellLexer, text, start, end, out);
    return end;
  }
  // The value lines since the last comment line.
  let valueStart = start;
  let valueEnd = start;
  for (const line of lines) {
    if (text[line.start + line.indent] === '#') {
      if (valueEnd > valueStart) out.push({ start: valueStart, end: valueEnd, kind: 'value' });
      out.push({ start: line.start + line.indent, end: line.end, kind: 'comment' });
      valueStart = Math.min(line.end + 1, n);
      valueEnd = valueStart;
    } else valueEnd = line.end;
  }
  if (valueEnd > valueStart) out.push({ start: valueStart, end: valueEnd, kind: 'value' });
  return end;
}

export const yamlLexer: Lexer = { languages: ['yaml'], lex: lexYaml };
