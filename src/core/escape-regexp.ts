// RegExp.escape doesn't exist in Node 22, the oldest version Sunset supports, so the matcher uses
// this instead.

const SYNTAX_CHARACTERS = /[\\^$.*+?()[\]{}|/-]/g;

/**
 * Escapes `text` so that it matches itself literally inside a regular expression, with or without
 * the `u` flag. `-` becomes `\x2d`: the `u` flag rejects `\-` outside a character class.
 */
export function escapeRegExp(text: string): string {
  return text.replace(SYNTAX_CHARACTERS, (c) => (c === '-' ? '\\x2d' : `\\${c}`));
}
