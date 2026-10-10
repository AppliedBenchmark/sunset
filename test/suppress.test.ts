import { describe, expect, it } from 'vitest';
import { lexerFor } from '../src/core/scan/lexers/index.ts';
import { LineIndex } from '../src/core/scan/lines.ts';
import { parseDirectives } from '../src/core/scan/suppress.ts';
import { brief } from './helpers.ts';

function directives(text: string) {
  const parsed = parseDirectives(text, lexerFor('javascript').lex(text), new LineIndex(text));
  return {
    directives: parsed.directives.map((d) => [d.kind, d.line, d.until, d.reason]),
    malformed: parsed.malformed.map((m) => m.message),
  };
}

describe('directive parsing', () => {
  it.each<[string, unknown[]]>([
    ['x // sunset-ignore', ['ignore', 1, null, null]],
    ['// sunset-ignore-next-line\nx', ['ignore-next-line', 2, null, null]],
    ['/* sunset-ignore-file */', ['ignore-file', 0, null, null]],
    ['x // sunset-ignore until=2099-06-30', ['ignore', 1, '2099-06-30', null]],
    [
      'x // sunset-ignore reason="moving off it" until=2099-06-30',
      ['ignore', 1, '2099-06-30', 'moving off it'],
    ],
    ["x // sunset-ignore reason='single quotes'", ['ignore', 1, null, 'single quotes']],
    ['x /* sunset-ignore reason=short */', ['ignore', 1, null, 'short']],
    // In a comment of several lines, the line after the comment ends, as in ESLint.
    ['/**\n * sunset-ignore-next-line\n */\nx', ['ignore-next-line', 4, null, null]],
    ['/* sunset-ignore-next-line reason="a"\n   b */ x', ['ignore-next-line', 3, null, 'a']],
    ['/*\n * sunset-ignore\n */', ['ignore', 2, null, null]],
  ])('%s', (text, expected) => {
    expect(directives(text)).toEqual({ directives: [expected], malformed: [] });
  });

  it.each([
    ['x // sunset-ignore until=2099-02-30', '"2099-02-30" is not a valid date'],
    ['x // sunset-ignore until=tomorrow', '"tomorrow" is not a valid date'],
    ['x // sunset-ignore because I said so', 'unexpected "because I said so"'],
    ['x // sunset-ignore-line', 'Unknown directive "sunset-ignore-line"'],
  ])('reports malformed directives: %s', (text, message) => {
    const parsed = directives(text);
    expect(parsed.directives).toEqual([]);
    expect(parsed.malformed[0]).toContain(message);
  });

  it('reads directives only in comments', () => {
    expect(directives('x = "sunset-ignore-file"')).toEqual({ directives: [], malformed: [] });
  });

  it('reads directives in comments that close on the same line', () => {
    const lua = '--[==[ sunset-ignore-next-line reason="a" ]==]\nx = 1';
    const parsed = parseDirectives(lua, lexerFor('lua').lex(lua), new LineIndex(lua));
    expect(parsed.directives.map((d) => [d.kind, d.line, d.reason])).toEqual([
      ['ignore-next-line', 2, 'a'],
    ]);
    expect(parsed.malformed).toEqual([]);
  });

  it('honours a custom prefix', () => {
    const text = '// acme-ignore-file';
    const parsed = parseDirectives(
      text,
      lexerFor('javascript').lex(text),
      new LineIndex(text),
      'acme',
    );
    expect(parsed.directives).toHaveLength(1);
  });
});

describe('suppression in the pipeline', () => {
  const code = [
    'a = "gpt-fixture-retired"  # sunset-ignore reason="tracked in #12"',
    '# sunset-ignore-next-line until=2099-06-30',
    'b = "gpt-fixture-retired"',
    'c = "gpt-fixture-retired"  # sunset-ignore until=2098-12-31',
    'd = "gpt-fixture-retired"',
  ].join('\n');

  it('suppresses with inline directives and re-activates expired ones', async () => {
    const { findings, suppressed } = await brief('a.py', code);
    expect(suppressed).toEqual(['inline 1 gpt-fixture-retired', 'inline 3 gpt-fixture-retired']);
    expect(findings).toEqual([
      'model-retired error 4:6 gpt-fixture-retired',
      'suppression-expired notice 4:30 sunset-ignore until=2098-12-31',
      'model-retired error 5:6 gpt-fixture-retired',
    ]);
  });

  it('suppresses a whole file', async () => {
    const { findings, suppressed } = await brief(
      'a.py',
      '# sunset-ignore-file\na = "gpt-fixture-retired"\nb = os.environ["MODEL"]\nclient.create(model=b)',
    );
    expect(findings).toEqual([]);
    expect(suppressed).toHaveLength(2);
  });

  it('applies config ignores by path, model and rule, with expiry', async () => {
    const files = {
      'src/a.py': 'a = "gpt-fixture-retired"\nb = "gpt-fixture-3"',
      'legacy/b.py': 'a = "gpt-fixture-retired"',
      'docs/c.md': 'gpt-fixture-retired',
    };
    const { scanFiles } = await import('./helpers.ts');
    const result = await scanFiles(files, {
      ignores: [
        { paths: ['legacy/**'], reason: 'frozen' },
        { models: ['gpt-fixture-3'], rules: ['model-deprecated'] },
        { models: ['openai:gpt-fixture-retired'], paths: ['docs/**'] },
        { paths: ['src/**'], until: '2098-01-01' as never, reason: 'old' },
      ],
    });
    expect(result.findings.map((f) => `${f.location.path} ${f.modelId}`)).toEqual([
      'src/a.py gpt-fixture-retired',
    ]);
    expect(result.suppressed.map((s) => `${s.by} ${s.location.path} ${s.reason}`)).toEqual([
      'config legacy/b.py frozen',
      'config src/a.py null',
    ]);
    expect(result.mentions).toEqual([]);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      'Config ignore #4 (old) expired on 2098-01-01; it no longer applies.',
    ]);
  });

  it('reports malformed directives as diagnostics', async () => {
    const { diagnostics, findings } = await brief(
      'a.py',
      'a = "gpt-fixture-retired"  # sunset-ignore until=someday',
    );
    expect(diagnostics).toEqual(['malformed-directive 1']);
    expect(findings).toHaveLength(1);
  });
});
