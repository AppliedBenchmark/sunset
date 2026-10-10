// The PR delta, pure part: which head findings are new compared with the base.
import { describe, expect, it } from 'vitest';
import { computeDelta } from '../src/core/delta.ts';
import type { ChangedFile } from '../src/core/ports.ts';
import { scanFiles } from './helpers.ts';

async function delta(
  base: Record<string, string>,
  head: Record<string, string>,
  changed: ChangedFile[],
) {
  const lines = (files: Record<string, string>) => (path: string, line: number) =>
    files[path]?.split('\n')[line - 1] ?? '';
  const result = computeDelta({
    head: await scanFiles(head),
    base: await scanFiles(base),
    changed,
    headLine: lines(head),
    baseLine: lines(base),
  });
  return {
    findings: result.findings.map((f) => `${f.location.path}:${f.location.line} ${f.modelId}`),
    unresolved: result.unresolved.map(
      (u) => `${u.location.path}:${u.location.line} ${u.expression}`,
    ),
  };
}

const modified = (path: string): ChangedFile => ({ path, previousPath: null, status: 'modified' });

describe('computeDelta', () => {
  it('reports every finding in an added file', async () => {
    expect(
      await delta({}, { 'new.py': 'A = "gpt-fixture-retired"\nmodel = os.environ["M"]\n' }, [
        { path: 'new.py', previousPath: null, status: 'added' },
      ]),
    ).toEqual({
      findings: ['new.py:1 gpt-fixture-retired'],
      unresolved: ['new.py:2 os.environ["M"]'],
    });
  });

  it("doesn't report findings that only moved, or changed indentation", async () => {
    const base = { 'a.py': 'A = "gpt-fixture-retired"\n\nB = "gpt-fixture-3"\n' };
    const head = {
      'a.py': '# a new comment\nB = "gpt-fixture-3"\n\n    A   =  "gpt-fixture-retired"\n',
    };
    expect(await delta(base, head, [modified('a.py')])).toEqual({ findings: [], unresolved: [] });
  });

  it('reports a finding whose line changed', async () => {
    const base = { 'a.py': 'A = "gpt-fixture-retired"\n' };
    const head = { 'a.py': 'A = "gpt-fixture-retired"  # still needed\n' };
    expect((await delta(base, head, [modified('a.py')])).findings).toEqual([
      'a.py:1 gpt-fixture-retired',
    ]);
  });

  it('counts duplicates: a second copy of the same line is new', async () => {
    const base = { 'a.py': 'A = "gpt-fixture-retired"\n' };
    const head = { 'a.py': 'A = "gpt-fixture-retired"\nA = "gpt-fixture-retired"\n' };
    expect((await delta(base, head, [modified('a.py')])).findings).toEqual([
      'a.py:2 gpt-fixture-retired',
    ]);
  });

  it('compares a renamed file with its old path', async () => {
    const base = { 'old.py': 'A = "gpt-fixture-retired"\n' };
    const head = { 'new.py': 'A = "gpt-fixture-retired"\nB = "gpt-fixture-3"\n' };
    expect(
      (await delta(base, head, [{ path: 'new.py', previousPath: 'old.py', status: 'renamed' }]))
        .findings,
    ).toEqual(['new.py:2 gpt-fixture-3']);
  });

  it("ignores files the pull request doesn't change", async () => {
    const files = { 'a.py': 'A = "gpt-fixture-retired"\n', 'b.py': 'B = "gpt-fixture-3"\n' };
    expect(await delta({}, files, [modified('b.py')])).toEqual({
      findings: ['b.py:1 gpt-fixture-3'],
      unresolved: [],
    });
  });

  it('treats a different model on the same line as new', async () => {
    const base = { 'a.py': 'A = "gpt-fixture-3"\n' };
    const head = { 'a.py': 'A = "gpt-fixture-3"  \n'.replace('3', 'retired') };
    expect((await delta(base, head, [modified('a.py')])).findings).toEqual([
      'a.py:1 gpt-fixture-retired',
    ]);
  });
});
