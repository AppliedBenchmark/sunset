// Lists and reads the files to scan.
//
// Inside a git work tree: `git ls-files -z --cached --others --exclude-standard`. Otherwise a
// directory walk that applies `.gitignore` files with the `ignore` package. Paths are
// relative to the scan root and POSIX-style. Symlinks, submodules and vanished files are skipped.
// Binary files (a NUL byte in the first 8 KiB) and files over the size cap read as null.
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import type { FileSource, ListOptions } from '../core/ports.ts';
import type { FileRef } from '../core/types.ts';

const run = promisify(execFile);
const BINARY_PROBE = 8 * 1024;

/** A file is binary when its first 8 KiB have a NUL byte. */
export const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_PROBE).includes(0);

export interface FileSourceOptions {
  /** Set to false to always walk the directory, even inside a git work tree. */
  git?: boolean;
}

export function createFileSource(options: FileSourceOptions = {}): FileSource {
  let root = '.';
  let maxFileSize = Number.POSITIVE_INFINITY;
  const decoder = new TextDecoder('utf-8');

  return {
    async *list(dir: string, opts: ListOptions): AsyncIterable<FileRef> {
      root = dir;
      maxFileSize = opts.maxFileSize;
      const paths = (options.git !== false && (await gitFiles(dir))) || (await walk(dir));
      for (const path of paths) {
        const stat = await lstat(join(dir, path)).catch(() => null);
        if (!stat?.isFile()) continue;
        yield { path, size: stat.size };
      }
    },

    async read(file: FileRef): Promise<string | null> {
      if (file.size > maxFileSize) return null;
      const bytes = await readFile(join(root, file.path)).catch(() => null);
      if (!bytes || bytes.length > maxFileSize) return null;
      if (isBinary(bytes)) return null;
      return decoder.decode(bytes);
    },
  };
}

/** The work tree's files, or null when `dir` isn't in a git work tree or git isn't available. */
async function gitFiles(dir: string): Promise<string[] | null> {
  try {
    const probe = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (probe.stdout.trim() !== 'true') return null;
    const { stdout } = await run(
      'git',
      ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: dir, maxBuffer: 512 * 1024 * 1024 },
    );
    const paths = new Set(stdout.split('\0').filter(Boolean));
    return [...paths].sort();
  } catch {
    return null;
  }
}

interface Rules {
  /** The directory the `.gitignore` is in, relative to the root, with a trailing `/` (or ''). */
  base: string;
  ig: Ignore;
}

/** Walks `dir`, applying every `.gitignore` on the way down; the deepest decisive rule wins. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: { rel: string; rules: Rules[] }[] = [{ rel: '', rules: [] }];
  while (stack.length > 0) {
    const { rel, rules: inherited } = stack.pop() as { rel: string; rules: Rules[] };
    const abs = join(dir, rel);
    const rules = [...inherited];
    const gitignore = await readFile(join(abs, '.gitignore'), 'utf8').catch(() => null);
    if (gitignore !== null) rules.push({ base: rel ? `${rel}/` : '', ig: ignore().add(gitignore) });

    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue;
      if (ignored(rules, isDir ? `${path}/` : path)) continue;
      if (isDir) stack.push({ rel: path, rules });
      else out.push(path);
    }
  }
  return out.sort();
}

function ignored(rules: readonly Rules[], path: string): boolean {
  let result = false;
  for (const { base, ig } of rules) {
    if (!path.startsWith(base)) continue;
    const test = ig.test(path.slice(base.length));
    if (test.ignored) result = true;
    else if (test.unignored) result = false;
  }
  return result;
}
