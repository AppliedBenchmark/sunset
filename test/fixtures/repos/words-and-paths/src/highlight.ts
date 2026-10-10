// `quokka` is a single-word model ID in this repo's registry, like OpenAI's `ada` and `davinci`.
import hljs from 'highlight.js/lib/core';

hljs.registerLanguage('quokka', require('highlight.js/lib/languages/quokka'));
export const LANGUAGES = ['bash', 'quokka', 'rust'];
export const UNITS = { activity: ['becquerel', 'quokka'] };
export const Badge = () => <span className="quokka">new</span>;
