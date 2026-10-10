// HTML snapshots: tables become one self-contained line per row.
import { describe, expect, it } from 'vitest';
import { normalizeText } from '../src/core/registry/normalize.ts';
import { htmlToText } from '../updater/html-to-text.ts';

const page = (body: string) =>
  `<html><head><title>t</title><script>var x = 1;</script></head><body>${body}</body></html>`;

describe('htmlToText', () => {
  it('repeats rowspan and colspan cells on every row they cover', () => {
    const html = page(`
      <div id="main-col-body">
        <table>
          <thead><tr><th>Provider</th><th>Model ID</th><th>Regions</th><th>EOL date</th></tr></thead>
          <tr><td rowspan="2">Anthropic</td><td rowspan="2">anthropic.claude-x-v1:0</td>
              <td><p>us-east-1</p><p>us-west-2</p></td><td>September 10, 2026</td></tr>
          <tr><td>us-gov-west-1<br>us-gov-east-1</td><td>March 1, 2027</td></tr>
          <tr><td colspan="2">Merged | cell</td><td>eu-west-1</td><td>—</td></tr>
        </table>
      </div>`);
    expect(normalizeText(htmlToText(html), 'text')).toBe(
      [
        '| Provider | Model ID | Regions | EOL date |',
        '| Anthropic | anthropic.claude-x-v1:0 | us-east-1 us-west-2 | September 10, 2026 |',
        '| Anthropic | anthropic.claude-x-v1:0 | us-gov-west-1 us-gov-east-1 | March 1, 2027 |',
        '| Merged \\| cell | Merged \\| cell | eu-west-1 | — |',
        '',
      ].join('\n'),
    );
  });

  it('keeps headings, paragraphs, lists and code; drops scripts and navigation', () => {
    const html = page(`
      <nav>Home</nav>
      <article>
        <h2>Date: 2026-09-10</h2>
        <p>Set <code>model='deepseek-x'</code>.<br>Next line.</p>
        <ul><li>One</li><li>Two <b>bold</b></li></ul>
        <pre>line 1
  line 2</pre>
        <style>p { color: red }</style>
      </article>`);
    expect(normalizeText(htmlToText(html), 'text')).toBe(
      [
        '## Date: 2026-09-10',
        '',
        "Set model='deepseek-x'.",
        'Next line.',
        '',
        '- One',
        '- Two bold',
        '',
        'line 1',
        'line 2',
        '',
      ].join('\n'),
    );
  });
});
