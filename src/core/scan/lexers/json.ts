// The JSON lexer: JSON, JSONC (comments) and JSON5 (also single-quoted strings, which can't occur
// outside a string in JSON), and notebooks that can't be read as nbformat (a merge conflict, say),
// which are then scanned like any JSON file.
import type { Lexer } from '../../ports.ts';
import { type Flavor, lexWith, simple } from './engine.ts';

const flavor: Flavor = {
  slashComments: true,
  nestedComments: false,
  hashComments: 'none',
  regexLiterals: false,
  phpTags: false,
  string: (text, i) => (text[i] === '"' || text[i] === "'" ? simple(i + 1, text[i]) : null),
};

export const jsonLexer: Lexer = {
  languages: ['json', 'notebook'],
  lex: (text) => lexWith(flavor, text),
};
