import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, systemClock } from '../src/adapters/clock.ts';
import { createFileSource, isBinary } from '../src/adapters/file-source.ts';
import type { FileRef } from '../src/core/types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sunset-files-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

async function list(git = true): Promise<FileRef[]> {
  const out: FileRef[] = [];
  for await (const ref of createFileSource({ git }).list(dir, { maxFileSize: 1000 })) {
    out.push(ref);
  }
  return out;
}

const tree = {
  '.gitignore': 'build/\n*.log\n!keep.log\n',
  'a.ts': 'x',
  'b.log': 'x',
  'keep.log': 'x',
  'build/out.js': 'x',
  'src/.gitignore': 'secret.ts\n',
  'src/secret.ts': 'x',
  'src/ok.ts': 'x',
  'src/deep/nested.py': 'x',
};
const expected = [
  '.gitignore',
  'a.ts',
  'keep.log',
  'src/.gitignore',
  'src/deep/nested.py',
  'src/ok.ts',
];

describe('file source', () => {
  it('walks a directory and applies nested .gitignore files', async () => {
    write(tree);
    expect((await list()).map((f) => f.path)).toEqual(expected);
  });

  it('uses git ls-files inside a work tree, including untracked files', async () => {
    write(tree);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      });
    git('init', '-q');
    git('add', 'a.ts');
    expect((await list()).map((f) => f.path)).toEqual(expected);
    // A tracked file is listed even if it matches .gitignore, as git does.
    git('add', '-f', 'b.log');
    expect((await list()).map((f) => f.path)).toContain('b.log');
    expect((await list(false)).map((f) => f.path)).not.toContain('b.log');
  });

  it('reports sizes and reads text, but not binaries, oversized or missing files', async () => {
    write({
      'text.ts': 'const a = 1;\n',
      'image.bin': Buffer.from([0x89, 0x50, 0x00, 0x47]),
      'big.ts': 'x'.repeat(1001),
    });
    const files = createFileSource({ git: false });
    const refs: FileRef[] = [];
    for await (const ref of files.list(dir, { maxFileSize: 1000 })) refs.push(ref);
    const byPath = Object.fromEntries(refs.map((r) => [r.path, r]));
    expect(byPath['big.ts']?.size).toBe(1001);
    expect(await files.read(byPath['text.ts'] as FileRef)).toBe('const a = 1;\n');
    expect(await files.read(byPath['image.bin'] as FileRef)).toBeNull();
    expect(await files.read(byPath['big.ts'] as FileRef)).toBeNull();
    expect(await files.read({ path: 'gone.ts', size: 1 })).toBeNull();
  });

  it('calls a file binary when its first 8 KiB have a NUL byte', () => {
    const at = (offset: number) => {
      const bytes = new Uint8Array(offset + 1).fill(0x61);
      bytes[offset] = 0;
      return bytes;
    };
    expect(isBinary(at(0))).toBe(true);
    expect(isBinary(at(8 * 1024 - 1))).toBe(true);
    expect(isBinary(at(8 * 1024))).toBe(false);
    expect(isBinary(new Uint8Array())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('skips symlinks', async () => {
    write({ 'real.ts': 'x' });
    symlinkSync(join(dir, 'real.ts'), join(dir, 'link.ts'));
    symlinkSync(tmpdir(), join(dir, 'outside'));
    expect((await list(false)).map((f) => f.path)).toEqual(['real.ts']);
  });
});

describe('clock', () => {
  it('gives a fixed or the current UTC date', () => {
    expect(fixedClock('2099-01-01').today()).toBe('2099-01-01');
    expect(() => fixedClock('2099-02-30')).toThrow(/not a valid date/);
    expect(systemClock.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
