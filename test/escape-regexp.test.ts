import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../src/core/escape-regexp.ts';

describe('escapeRegExp', () => {
  it.each([
    ['gpt-4o-2024-08-06', 'gpt\\x2d4o\\x2d2024\\x2d08\\x2d06'],
    ['anthropic.claude-v2:1', 'anthropic\\.claude\\x2dv2:1'],
    ['claude-3-5-sonnet@20240620', 'claude\\x2d3\\x2d5\\x2dsonnet@20240620'],
    ['publishers/google/models/x', 'publishers\\/google\\/models\\/x'],
    ['a(b)[c]{d}|e^f$g*h+i?j\\k', 'a\\(b\\)\\[c\\]\\{d\\}\\|e\\^f\\$g\\*h\\+i\\?j\\\\k'],
  ])('escapes %s', (input, expected) => {
    expect(escapeRegExp(input)).toBe(expected);
  });

  it('escapes `-` so that the `u` flag accepts it, also inside a character class', () => {
    expect(new RegExp(`^${escapeRegExp('a-b')}$`, 'u').test('a-b')).toBe(true);
    expect(new RegExp(`^[a${escapeRegExp('-')}c]$`, 'u').test('b')).toBe(false);
  });

  it('produces a pattern that matches exactly the input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        for (const flags of ['', 'u']) {
          const pattern = new RegExp(`^${escapeRegExp(text)}$`, flags);
          expect(pattern.test(text)).toBe(true);
        }
      }),
    );
  });
});
