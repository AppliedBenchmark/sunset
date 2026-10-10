// Normalizes a fetched source page to stable text. Snapshots are stored normalized, so they diff
// cleanly and excerpts can be checked against them. HTML is turned into text by
// the updater first; this module only sees text.

/** Stored in each snapshot's `.meta.json`. Bump it whenever the output of `normalizeText` changes. */
export const NORMALIZER_VERSION = 1;

export type NormalizeFormat = 'markdown' | 'text';

// Hyphens and spaces that look like ASCII ones (OpenAI writes some dates with U+2011).
const HYPHENS = /[\u2010\u2011]/g;
const SPACES = /[\u00a0\u2007\u202f\t]/g;
// Zero-width characters (DeepSeek puts U+200B in some anchors).
const INVISIBLE = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;
const MD_IMAGE = /!\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g;
const MD_LINK = /\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Returns the stable text of a page:
 * - Unicode NFC; look-alike hyphens and spaces become ASCII; zero-width characters are removed
 * - line endings become `\n`
 * - Markdown: links and images keep only their text, and HTML comments are removed
 * - each line is trimmed and runs of spaces collapse to one; runs of blank lines collapse to one
 */
export function normalizeText(text: string, format: NormalizeFormat): string {
  let out = text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(HYPHENS, '-')
    .replace(SPACES, ' ')
    .replace(INVISIBLE, '');
  if (format === 'markdown') {
    out = out.replace(HTML_COMMENT, '').replace(MD_IMAGE, '$1').replace(MD_LINK, '$1');
  }
  const lines: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/ {2,}/g, ' ').trim();
    if (line === '' && (lines.length === 0 || lines.at(-1) === '')) continue;
    lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** Collapses every run of whitespace, including line breaks, so excerpts can span lines. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
