// Terminal colors for the text report. `util.styleText` with `validateStream` drops
// the colors when the stream isn't a TTY and honors NO_COLOR, NODE_DISABLE_COLORS and FORCE_COLOR.
import { styleText } from 'node:util';
import { plainStyle, type Style } from '../report/text.ts';

type Format = Parameters<typeof styleText>[0];

export function terminalStyle(stream: NodeJS.WritableStream = process.stdout, color = true): Style {
  if (!color) return plainStyle;
  // One format per call: given an array, Node 22.13 and 22.14 skip the stream check and color a
  // pipe, a file or NO_COLOR output anyway (fixed in 22.15).
  return (format, text) =>
    (Array.isArray(format) ? format : [format]).reduceRight<string>(
      (styled, f) => styleText(f as Format, styled, { validateStream: true, stream }),
      text,
    );
}
