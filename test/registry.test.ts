// The committed registry/ directory is valid: every entry is grounded in its committed snapshot,
// offline. `npm run registry:validate` runs the same checks with a review table.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../src/adapters/clock.ts';
import { validateRegistryDir } from '../src/adapters/registry-files.ts';
import { root } from './helpers.ts';

describe('registry/', () => {
  it('validates with no errors', async () => {
    const report = await validateRegistryDir(join(root, 'registry'), systemClock.today());
    const errors = report.issues
      .filter((i) => i.level === 'error')
      .map((i) => `${i.file} ${i.subject ?? ''}: ${i.message}`);
    expect(errors).toEqual([]);
    expect(report.registry).not.toBeNull();
    expect(report.sources).not.toBeNull();
    expect(report.formats).not.toBeNull();
  });
});
