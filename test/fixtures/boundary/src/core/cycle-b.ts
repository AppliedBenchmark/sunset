import { a } from './cycle-a.ts';

export const b = (): number => a() - 1;
