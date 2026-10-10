// Scan paths are relative to the scanned directory. Annotations, SARIF and links need them relative
// to the repository root, so the CLI and the Action prefix them when they scan a subdirectory.
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { Git } from '../adapters/git.ts';
import type { PrDelta } from '../core/delta.ts';
import type { Location, ScanResult } from '../core/types.ts';

/**
 * The scanned directory's path from the repository's top level, as a prefix such as `svc/`, or ''
 * at the top level. In a work tree, git works it out from the directory itself, so the top level's
 * path, which can be spelled unlike `root` (case, a drive letter, a Windows short name, a link),
 * is never compared with it. Outside a work tree, the prefix is the path from `outside` (the
 * Action's workspace) when the directory is in it, and '' otherwise.
 */
export async function repositoryPrefix(
  git: Pick<Git, 'prefix'>,
  root: string,
  outside: string | null = null,
): Promise<string> {
  const prefix = await git.prefix();
  if (prefix !== null) return prefix;
  if (outside === null) return '';
  const resolved = (path: string) => realpath(path).catch(() => path);
  const rel = relative(await resolved(outside), await resolved(root));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return '';
  return `${rel.split(sep).join('/')}/`;
}

export function rebaseLocation(location: Location, prefix: string): Location {
  return { ...location, path: `${prefix}${location.path}` };
}

/** A copy of `item` with its location rebased, or `item` itself when there is no prefix. */
export function rebaseItem<T extends { location: Location }>(item: T, prefix: string): T {
  return prefix ? { ...item, location: rebaseLocation(item.location, prefix) } : item;
}

/** `prefix` is a POSIX directory ending in `/`, or '' for none. */
export function rebaseResult(result: ScanResult, prefix: string): ScanResult {
  if (!prefix) return result;
  const at = <T extends { location: Location }>(item: T): T => rebaseItem(item, prefix);
  return {
    ...result,
    findings: result.findings.map(at),
    unresolved: result.unresolved.map(at),
    mentions: result.mentions.map(at),
    suppressed: result.suppressed.map(at),
    inventory: result.inventory.map((i) => ({
      ...i,
      locations: i.locations.map((l) => rebaseLocation(l, prefix)),
    })),
    diagnostics: result.diagnostics.map((d) =>
      d.location ? { ...d, location: rebaseLocation(d.location, prefix) } : d,
    ),
  };
}

export function rebaseDelta(delta: PrDelta, prefix: string): PrDelta {
  if (!prefix) return delta;
  return {
    findings: delta.findings.map((f) => rebaseItem(f, prefix)),
    unresolved: delta.unresolved.map((u) => rebaseItem(u, prefix)),
  };
}
