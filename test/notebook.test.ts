import { describe, expect, it } from 'vitest';
import { lexerFor } from '../src/core/scan/lexers/index.ts';
import { CellText, readNotebook } from '../src/core/scan/notebook.ts';
import type { Location } from '../src/core/types.ts';
import { brief, scanFiles } from './helpers.ts';

interface CellSpec {
  type?: string;
  /** A list of lines, as Jupyter writes it, or one string. */
  source: string | string[];
  outputs?: unknown[];
  attachments?: unknown;
}

/** A notebook laid out the way Jupyter saves it, with one key per line. */
function notebook(cells: CellSpec[], metadata: unknown = {}): string {
  return JSON.stringify(
    {
      cells: cells.map((c) => ({
        ...(c.attachments !== undefined && { attachments: c.attachments }),
        cell_type: c.type ?? 'code',
        metadata: {},
        ...((c.type ?? 'code') === 'code' && { execution_count: null, outputs: c.outputs ?? [] }),
        source: c.source,
      })),
      metadata,
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  );
}

/** The file text at a location, which must be on one line. */
function textAt(file: string, l: Location): string {
  return (file.split('\n')[l.line - 1] as string).slice(l.column - 1, l.endColumn - 1);
}

const python = { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } };

describe('reading notebooks', () => {
  it('joins and decodes each cell source', () => {
    const nb = readNotebook(
      notebook([
        { source: ['x = "a\\tb"\n', 'print(x)'] },
        { type: 'markdown', source: 'Café \u{1f600}' },
        { type: 'raw', source: [] },
      ]),
    );
    expect(nb?.cells.map((c) => [c.code, c.text])).toEqual([
      [true, 'x = "a\\tb"\nprint(x)'],
      [false, 'Café \u{1f600}'],
      [false, ''],
    ]);
  });

  it('decodes every JSON escape', () => {
    const nb = readNotebook(
      '{"cells": [{"cell_type": "code", "source": "\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00"}]}',
    );
    expect(nb?.cells[0]?.text).toBe('"\\/\b\f\n\r\té\u{1f600}');
  });

  it.each<[unknown, string]>([
    [python, 'python'],
    [{ language_info: { name: 'python' } }, 'python'],
    [
      { kernelspec: { language: 'typescript' }, language_info: { name: 'typescript' } },
      'javascript',
    ],
    [{ kernelspec: { display_name: '.NET (C#)', language: 'C#', name: '.net-csharp' } }, 'csharp'],
    [{ kernelspec: { language: 'C++17' } }, 'c'],
    [{ kernelspec: { language: 'bash' } }, 'shell'],
    [{ kernelspec: { language: 'PowerShell' } }, 'powershell'],
    [{ kernelspec: { language: 'R' } }, 'r'],
    // Unknown, missing or malformed: Python, which reads `#` comments as Julia does.
    [{ kernelspec: { language: 'julia' } }, 'python'],
    [{}, 'python'],
    [{ kernelspec: null, language_info: 'python' }, 'python'],
  ])('lexes code cells for %j as %s', (metadata, language) => {
    expect(readNotebook(notebook([{ source: 'x' }], metadata))?.language).toBe(language);
  });

  it('reads escaped keys and tolerates odd values', () => {
    const nb = readNotebook(
      '{"\\u0063ells": [{"cell_type": null, "source": "a"}, {"cell_type": "code", "source": 1}]}',
    );
    expect(nb?.cells.map((c) => [c.code, c.text])).toEqual([
      [false, 'a'],
      [true, ''],
    ]);
  });

  it('skips outputs and metadata of any depth', () => {
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    const text = notebook([
      { source: 'x', outputs: [{ output_type: 'stream', text: ['{"cells": [] }\n'] }] },
    ]).replace('"metadata": {}', `"metadata": {"deep": ${deep}, "s": "\\"}{"}`);
    expect(readNotebook(text)?.cells.map((c) => c.text)).toEqual(['x']);
  });

  it.each([
    ['not JSON', '<<<<<<< HEAD\n{"cells": []}'],
    ['truncated', '{"cells": [{"cell_type": "code", "source": "x'],
    ['trailing text', '{"cells": []} x'],
    ['a bad escape', '{"cells": [{"source": "\\q"}]}'],
    ['a bad unicode escape', '{"cells": [{"source": "\\u00g9"}]}'],
    ['an unterminated output', '{"cells": [{"outputs": ["x]}]}'],
    ['an unclosed output', '{"cells": [{"outputs": [[]}]}'],
    ['a missing value', '{"cells": [], "nbformat": }'],
    ['a raw newline in a string', '{"cells": [{"source": "a\nb"}]}'],
    ['no cells', '{"metadata": {}, "nbformat": 4}'],
    ['nbformat 3', '{"worksheets": [{"cells": []}], "nbformat": 3}'],
    ['cells that are not objects', '{"cells": ["x"]}'],
  ])('returns null for %s', (_, text) => {
    expect(readNotebook(text)).toBeNull();
  });
});

describe('cell text', () => {
  // In the file: "a = \"x\\\"y\"\n", "b = 1" and "c = \"\\u00e9\"\nd = 2".
  const file = notebook([
    { source: ['a = "x\\"y"\n', 'b = 1'] },
    { source: 'c = "é"\nd = 2' },
  ]).replace('é', '\\u00e9');
  const text = new CellText(file, readNotebook(file)?.cells ?? []);

  /** The file text that the first `s` in the cell text maps to. */
  const inFile = (s: string): string => {
    const start = text.text.indexOf(s);
    const at = text.toFile(start, start + s.length);
    return file.slice(at.start, at.end);
  };

  it('joins cells with a blank line between them', () => {
    expect(text.text).toBe('a = "x\\"y"\nb = 1\n\nc = "é"\nd = 2');
  });

  it('maps offsets back to the file, escapes included', () => {
    expect(inFile('"x\\"y"')).toBe('\\"x\\\\\\"y\\"');
    expect(inFile('b = 1')).toBe('b = 1');
    expect(inFile('"é"')).toBe('\\"\\u00e9\\"');
    expect(inFile('é')).toBe('\\u00e9');
    expect(inFile('\nd')).toBe('\\nd');
    const empty = text.toFile(4, 4);
    expect(empty.end).toBe(empty.start);
  });

  it('lexes each cell on its own', () => {
    const open = notebook([{ source: 's = """never closed\n' }, { source: 't = "x"' }]);
    const lexed = new CellText(open, readNotebook(open)?.cells ?? []);
    const spans = lexed.lex(lexerFor('python'));
    expect(spans.map((s) => [s.kind, lexed.text.slice(s.start, s.end)])).toEqual([
      ['string', 'never closed\n'],
      ['string', 'x'],
    ]);
    expect(spans[1]?.open).toBe(lexed.text.indexOf('"x"'));
  });

  it('measures the UTF-8 size of the cells, without the separators', () => {
    expect(text.size()).toBe(new TextEncoder().encode('a = "x\\"y"\nb = 1c = "é"\nd = 2').length);
  });
});

describe('notebooks in the pipeline', () => {
  it('reports code cells as code, and markdown and raw cells as mentions', async () => {
    const text = notebook(
      [
        {
          type: 'markdown',
          source: ['# Guide\n', 'This guide compares gpt-fixture-retired with gpt-fixture-3.'],
        },
        { source: ['# gpt-fixture-retired was the default\n', 'model = "gpt-fixture-retired"'] },
        { type: 'raw', source: 'gpt-fixture-3' },
      ],
      python,
    );
    const { findings, mentions, result } = await brief('guide.ipynb', text);
    expect(findings).toEqual(['model-retired error 18:16 gpt-fixture-retired']);
    expect(mentions).toEqual([
      '8:26 gpt-fixture-retired',
      '8:51 gpt-fixture-3',
      '24:15 gpt-fixture-3',
    ]);
    expect(result.findings[0]?.fileClass).toBe('code');
    for (const { location, modelId } of [...result.findings, ...result.mentions]) {
      expect(textAt(text, location)).toBe(modelId);
    }
  });

  it('ignores outputs and attachments', async () => {
    const { findings, mentions, inventory } = await brief(
      'run.ipynb',
      notebook([
        {
          source: 'print(resp.model)',
          outputs: [
            { name: 'stdout', output_type: 'stream', text: ['gpt-fixture-retired\n'] },
            { output_type: 'display_data', data: { 'text/plain': 'gpt-fixture-3' } },
          ],
        },
        {
          type: 'markdown',
          source: '![x](attachment:x.png)',
          attachments: { 'x.png': { 'text/plain': 'gpt-fixture-retired' } },
        },
      ]),
    );
    expect([findings, mentions, inventory]).toEqual([[], [], []]);
  });

  it('applies directives by the lines of each cell', async () => {
    const text = notebook([
      {
        source: [
          '# sunset-ignore-next-line\n',
          'a = "gpt-fixture-retired"\n',
          'b = "gpt-fixture-retired"',
        ],
      },
      // One string holding the whole cell: its lines are all on one line of the file.
      { source: '# sunset-ignore-next-line\nc = "gpt-fixture-retired"\nd = "gpt-fixture-retired"' },
      // A directive on a cell's last line doesn't reach into the next cell.
      { source: 'e = 1  # sunset-ignore-next-line' },
      { source: 'f = "gpt-fixture-retired"' },
    ]);
    const { findings, result } = await brief('a.ipynb', text);
    expect(result.suppressed.map((s) => `${s.location.line}:${s.location.column}`)).toEqual([
      '10:12',
      '19:48',
    ]);
    expect(findings).toEqual([
      'model-retired error 11:12 gpt-fixture-retired',
      'model-retired error 19:77 gpt-fixture-retired',
      'model-retired error 33:21 gpt-fixture-retired',
    ]);
    for (const { location } of [...result.findings, ...result.suppressed]) {
      expect(textAt(text, location)).toBe('gpt-fixture-retired');
    }
  });

  it('applies ignore-file to every code cell', async () => {
    const { findings, mentions, suppressed } = await brief(
      'a.ipynb',
      notebook([
        { source: 'a = "gpt-fixture-retired"' },
        { source: '# sunset-ignore-file' },
        { type: 'markdown', source: 'gpt-fixture-retired' },
      ]),
    );
    expect(findings).toEqual([]);
    expect(suppressed).toEqual(['inline 8 gpt-fixture-retired']);
    // Directives never apply to mentions, as in other docs.
    expect(mentions).toEqual(['20:15 gpt-fixture-retired']);
  });

  it('reports expired and malformed directives where they are in the file', async () => {
    const text = notebook([
      {
        source: [
          'x = "gpt-fixture-3"\n',
          'y = 2  # sunset-ignore until=2098-01-01\n',
          'z = 3  # sunset-ignore until=soon',
        ],
      },
    ]);
    const { findings, result } = await brief('a.ipynb', text);
    expect(findings).toEqual([
      'model-deprecated notice 9:12 gpt-fixture-3',
      'suppression-expired notice 10:15 sunset-ignore until=2098-01-01',
    ]);
    const [diagnostic] = result.diagnostics;
    expect(diagnostic?.location && textAt(text, diagnostic.location)).toBe(
      'sunset-ignore until=soon',
    );
  });

  it('reads shell commands and magics as IPython runs them', async () => {
    const text = notebook(
      [
        {
          source: [
            '!pip install llm\n',
            '!llm "Say hi" -m gpt-fixture-retired\n',
            'out = !python eval.py gpt-fixture-3\n',
            '%env JUDGE=claude-fixture-opus-9',
          ],
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['gpt-fixture-2-2099-02-15\n'] },
          ],
        },
        {
          source: [
            '%%bash\n',
            '# sunset-ignore-next-line\n',
            'python eval.py gpt-fixture-retired\n',
            'export FALLBACK=gemini-fixture-1.0-flash',
          ],
        },
        { source: ['%%writefile eval.yaml\n', 'model: mistral-fixture-large-2099'] },
        {
          source: [
            '%%time\n',
            'for m in models:\n',
            '    !python bench.py gpt-fixture-1-2099-01-10',
          ],
        },
      ],
      python,
    );
    const { findings, result } = await brief('magics.ipynb', text);
    expect(findings).toEqual([
      'model-retired error 18:25 gpt-fixture-retired',
      'model-deprecated notice 19:28 gpt-fixture-3',
      'model-retiring warning 20:17 claude-fixture-opus-9',
      'model-retiring warning 32:22 gemini-fixture-1.0-flash',
      'model-retiring warning 42:13 mistral-fixture-large-2099',
      'model-retiring error 53:27 gpt-fixture-1-2099-01-10',
    ]);
    expect(result.suppressed.map((s) => `${s.location.line}:${s.location.column}`)).toEqual([
      '31:21',
    ]);
    for (const { location, modelId } of [...result.findings, ...result.suppressed]) {
      expect(textAt(text, location)).toBe(modelId);
    }
  });

  it('lexes code cells in the kernel language', async () => {
    const { findings } = await brief(
      'deno.ipynb',
      notebook([{ source: ['// gpt-fixture-retired is gone\n', 'const m = "gpt-fixture-3";'] }], {
        kernelspec: { language: 'typescript' },
      }),
    );
    expect(findings).toEqual(['model-deprecated notice 10:18 gpt-fixture-3']);
  });

  it('turns every cell of a docs notebook into mentions', async () => {
    const { findings, mentions } = await brief(
      'docs/tour.ipynb',
      notebook([
        {
          source: 'm = "gpt-fixture-retired"',
          outputs: [{ output_type: 'stream', text: 'gpt-fixture-3' }],
        },
      ]),
    );
    expect(findings).toEqual([]);
    expect(mentions).toEqual(['13:21 gpt-fixture-retired']);
  });

  it('tags findings in a test notebook', async () => {
    const { result } = await brief(
      'tests/smoke.ipynb',
      notebook([{ source: 'm = "gpt-fixture-retired"' }]),
    );
    expect(result.findings.map((f) => f.fileClass)).toEqual(['test']);
  });

  it('measures code cells against the size limit, not the file', async () => {
    const image = 'iVBORw0KGgo'.repeat(500);
    const text = notebook([
      {
        source: 'm = "gpt-fixture-retired"',
        outputs: [{ output_type: 'display_data', data: { 'image/png': image } }],
      },
      { type: 'markdown', source: image },
    ]);
    expect(text.length).toBeGreaterThan(10_000);
    const fits = await brief('a.ipynb', text, { maxFileSize: 1000 });
    expect(fits.findings).toEqual(['model-retired error 15:21 gpt-fixture-retired']);

    const tooMuchCode = notebook([{ source: `m = "gpt-fixture-retired"  # ${'x'.repeat(1000)}` }]);
    const skipped = await brief('a.ipynb', tooMuchCode, { maxFileSize: 1000 });
    expect(skipped.findings).toEqual([]);
    expect(skipped.result.stats.files.skipped['too-large']).toBe(1);
  });

  it('skips other files over the size limit while reading larger notebooks', async () => {
    const padding = 'x'.repeat(200);
    const result = await scanFiles(
      {
        'big.ipynb': notebook([
          {
            source: 'm = "gpt-fixture-retired"',
            outputs: [{ output_type: 'stream', text: padding }],
          },
        ]),
        'big.py': `m = "gpt-fixture-retired"  # ${padding}`,
      },
      { maxFileSize: 100 },
    );
    expect(result.findings.map((f) => f.location.path)).toEqual(['big.ipynb']);
    expect(result.stats.files.skipped['too-large']).toBe(1);
  });

  it('scans a notebook that is not valid JSON as JSON, within the usual size limit', async () => {
    const conflict = [
      '{"cells": [{"cell_type": "code", "source": [',
      '<<<<<<< HEAD',
      '  "model = \\"gpt-fixture-retired\\""',
      '=======',
      '  "model = \\"gpt-fixture-3\\""',
      '>>>>>>> branch',
      ']}]}',
    ].join('\n');
    const { findings, result } = await brief('a.ipynb', conflict);
    // As JSON, each source line is a string with spaces, which counts only after a model key.
    expect(findings).toEqual([
      'model-retired error 3:14 gpt-fixture-retired',
      'model-deprecated notice 5:14 gpt-fixture-3',
    ]);
    expect(result.stats.files.lexed).toBe(1);
    const capped = await brief('a.ipynb', conflict, { maxFileSize: 100 });
    expect(capped.findings).toEqual([]);
    expect(capped.result.stats.files.skipped['too-large']).toBe(1);
  });
});
