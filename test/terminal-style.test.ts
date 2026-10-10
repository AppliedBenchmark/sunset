// The text report's color adapter.
import { PassThrough } from 'node:stream';
import { WriteStream } from 'node:tty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalStyle } from '../src/adapters/terminal-style.ts';

/** A stream that passes for a TTY; color support is decided by Node's own logic (env vars). */
const tty = () =>
  Object.assign(new PassThrough(), {
    isTTY: true,
    getColorDepth: (...args: unknown[]) =>
      (WriteStream.prototype.getColorDepth as (...a: unknown[]) => number).apply({}, args),
  });

describe('terminalStyle', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('colors a TTY', () => {
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', undefined);
    expect(terminalStyle(tty())(['red', 'bold'], 'x')).toBe(
      '\u001b[31m\u001b[1mx\u001b[22m\u001b[39m',
    );
  });

  it('leaves a pipe or file uncolored', () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    expect(terminalStyle(new PassThrough())('red', 'x')).toBe('x');
    expect(terminalStyle(new PassThrough())(['red', 'bold'], 'x')).toBe('x');
  });

  it('honors NO_COLOR', () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', '1');
    expect(terminalStyle(tty())('red', 'x')).toBe('x');
    expect(terminalStyle(tty())(['red', 'bold'], 'x')).toBe('x');
  });

  it('turns colors off on request (--no-color)', () => {
    expect(terminalStyle(tty(), false)('red', 'x')).toBe('x');
  });
});
