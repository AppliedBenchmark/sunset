// Turns an HTML page into plain text for its snapshot. Tables become one `| … |` line per row with
// rowspan and colspan cells repeated, so every row stands alone and an excerpt from one row
// carries all of its values. The result still goes through normalizeText.
import { type Cheerio, load } from 'cheerio';
import { type AnyNode, type Element, isTag, isText } from 'domhandler';

// The page's main content, in order of preference; the rest is navigation and chrome.
const CONTENT_ROOTS = ['#main-col-body', 'article', 'main', 'body'];
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'nav', 'button', 'head']);
const BLOCK = new Set([
  'address',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'ol',
  'p',
  'section',
  'summary',
  'ul',
]);

class Writer {
  readonly lines: string[] = [];
  private current = '';

  text(text: string): void {
    this.current += text.replace(/\s+/g, ' ');
  }

  raw(text: string): void {
    this.current += text;
  }

  /** Ends the current line, if it has any text. */
  break(): void {
    const line = this.current.trim();
    if (line) this.lines.push(line);
    this.current = '';
  }

  blank(): void {
    this.break();
    if (this.lines.at(-1) !== '') this.lines.push('');
  }
}

/** The text of a node on one line (used for table cells); line breaks become spaces. */
function inlineText($node: Cheerio<AnyNode>): string {
  const $copy = $node.clone();
  $copy.find('br').replaceWith(' ');
  $copy.find('p, div, li').append(' ');
  return $copy.text().replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function renderTable(table: Element, $: ReturnType<typeof load>, out: Writer): void {
  // grid[row][col]; a spanned cell is copied into every slot it covers.
  const grid: string[][] = [];
  const rows = $(table).find('tr').toArray();
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of $(row).children('th, td').toArray()) {
      const line = grid[r] as string[];
      while (line[c] !== undefined) c++;
      const text = inlineText($(cell));
      const rowspan = Math.max(1, Number($(cell).attr('rowspan')) || 1);
      const colspan = Math.max(1, Number($(cell).attr('colspan')) || 1);
      for (let dr = 0; dr < rowspan && r + dr < rows.length; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) (grid[r + dr] as string[])[c + dc] = text;
      }
      c += colspan;
    }
  });
  out.blank();
  for (const line of grid) {
    const cells = Array.from(line, (cell) => cell ?? '');
    if (cells.length) out.lines.push(`| ${cells.join(' | ')} |`);
  }
  out.blank();
}

function render(node: AnyNode, $: ReturnType<typeof load>, out: Writer): void {
  if (isText(node)) {
    out.text(node.data);
    return;
  }
  if (!isTag(node)) return;
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag)) return;
  if (tag === 'table') {
    renderTable(node, $, out);
    return;
  }
  if (tag === 'br') {
    out.break();
    return;
  }
  if (tag === 'pre') {
    out.blank();
    for (const line of $(node).text().split('\n')) out.lines.push(line.trimEnd());
    out.blank();
    return;
  }
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    out.blank();
    out.raw(`${'#'.repeat(Number(heading[1]))} `);
  } else if (tag === 'li') {
    out.break();
    out.raw('- ');
  } else if (BLOCK.has(tag)) {
    out.break();
  }
  for (const child of node.children) render(child, $, out);
  if (heading) out.blank();
  else if (tag === 'p') out.blank();
  else if (BLOCK.has(tag)) out.break();
}

export function htmlToText(html: string): string {
  const $ = load(html);
  const root = CONTENT_ROOTS.map((selector) => $(selector).first()).find((el) => el.length > 0);
  const out = new Writer();
  for (const node of root?.toArray() ?? []) render(node, $, out);
  out.break();
  return `${out.lines.join('\n')}\n`;
}

/**
 * For each class, the first cell of every table row that has it, as one line of text (on the
 * Gemini API page, `row-gray` marks shut-down models and nothing else does).
 */
export function rowClasses(html: string, classes: readonly string[]): Record<string, string[]> {
  const $ = load(html);
  const out: Record<string, string[]> = {};
  for (const name of classes) {
    out[name] = $('tr')
      .filter((_, row) => $(row).hasClass(name))
      .toArray()
      .map((row) => inlineText($(row).children('th, td').first()).replace(/\\\|/g, '|'))
      .filter((text) => text !== '');
  }
  return out;
}
