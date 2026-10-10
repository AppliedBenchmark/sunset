// Every lexer, by language. Each language has exactly one lexer.
import type { Lexer } from '../../ports.ts';
import type { Language } from '../../types.ts';
import { C_LIKE_LEXERS } from './c-like.ts';
import { HASH_LEXERS } from './hash.ts';
import { hclLexer } from './hcl.ts';
import { htmlLexer } from './html.ts';
import { jsonLexer } from './json.ts';
import { luaLexer } from './lua.ts';
import { powershellLexer } from './powershell.ts';
import { pythonLexer } from './python.ts';
import { yamlLexer } from './yaml.ts';

export const LEXERS: readonly Lexer[] = [
  ...C_LIKE_LEXERS,
  pythonLexer,
  ...HASH_LEXERS,
  yamlLexer,
  jsonLexer,
  hclLexer,
  powershellLexer,
  htmlLexer,
  luaLexer,
];

const byLanguage = new Map<Language, Lexer>();
for (const lexer of LEXERS) {
  for (const language of lexer.languages) byLanguage.set(language, lexer);
}

export function lexerFor(language: Language): Lexer {
  const lexer = byLanguage.get(language);
  if (!lexer) throw new Error(`no lexer for ${language}`);
  return lexer;
}
