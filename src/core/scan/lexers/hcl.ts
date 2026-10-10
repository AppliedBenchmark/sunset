// The HCL lexer: Terraform and other HCL files. `#`, `//` and `/* */` comments;
// strings with `${…}` and `%{…}`; heredocs `<<EOT` and `<<-EOT`. A heredoc that is a script is
// lexed as shell, so that each word of its commands is its own value, as in a script file.
import type { Lexer } from '../../ports.ts';
import type { Span } from '../../types.ts';
import { type Flavor, heredocStart, lexPart, lexWith, simple } from './engine.ts';
import { shellLexer } from './hash.ts';

const flavor: Flavor = {
  slashComments: true,
  nestedComments: false,
  hashComments: 'anywhere',
  regexLiterals: false,
  phpTags: false,
  string(text, i) {
    if (text[i] === '"') return simple(i + 1, '"', { interp: 'hcl' });
    // HCL has `<<EOT` and `<<-EOT`, but not `<<~EOT`.
    const doc = text[i + 2] === '~' ? null : heredocStart(text, i, '<<');
    if (doc) {
      return simple(doc.contentStart, '', {
        multiline: true,
        escape: 'none',
        interp: 'hcl',
        heredoc: doc.id,
      });
    }
    return null;
  },
};

/**
 * Attributes that hold a script: an instance's `user_data` or `custom_data` (a shell script or
 * cloud-init), a Compute Engine startup script, and a provisioner's `command` or `inline`.
 */
const SCRIPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'user_data',
  'user_data_base64',
  'custom_data',
  'metadata_startup_script',
  'startup-script',
  'command',
  'inline',
]);

/**
 * The attribute before a heredoc on its line, assigned directly, in a list or through calls:
 * `user_data = base64encode(<<-EOF`, `inline = [<<-EOT`.
 */
const ATTRIBUTE = /(?:^|[\s{,])"?([A-Za-z_][\w-]*)"?[ \t]*[=:][ \t]*(?:[\w.]+\([ \t]*|\[[ \t]*)*$/;

/** Whether the heredoc opened at `open`, with its body at `body`, is a script. */
function isScript(text: string, open: number, body: number): boolean {
  if (/^[ \t]*#!/.test(text.slice(body, body + 64))) return true;
  const lineStart = text.lastIndexOf('\n', open - 1) + 1;
  const before = text.slice(Math.max(lineStart, open - 200), open);
  return SCRIPT_ATTRIBUTES.has(ATTRIBUTE.exec(before)?.[1] ?? '');
}

/**
 * Lexes the body of each heredoc that is a script as shell, in place of its string segments and
 * the strings in its interpolations. A JSON policy or a description stays one string.
 */
function scriptHeredocs(text: string, spans: Span[]): Span[] {
  // The last segment of each literal, by where it opens.
  const last = new Map<number, number>();
  spans.forEach((span, k) => {
    if (span.open !== undefined) last.set(span.open, k);
  });
  const out: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    const span = spans[k] as Span;
    const open = span.open;
    if (open === undefined || !text.startsWith('<<', open) || !isScript(text, open, span.start)) {
      out.push(span);
      continue;
    }
    const end = last.get(open) as number;
    lexPart(shellLexer, text, span.start, (spans[end] as Span).end, out);
    k = end;
  }
  return out;
}

export const hclLexer: Lexer = {
  languages: ['hcl'],
  lex: (text) => scriptHeredocs(text, lexWith(flavor, text)),
};
