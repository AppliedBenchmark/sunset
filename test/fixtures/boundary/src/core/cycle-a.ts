import { b } from './cycle-b.ts';

export const a = (): number => b() + 1;
