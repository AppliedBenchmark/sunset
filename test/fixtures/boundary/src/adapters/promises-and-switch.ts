export async function work(): Promise<boolean> {
  return true;
}

export function floating(): void {
  work();
}

export function misused(): number {
  if (work()) {
    return 1;
  }
  return 0;
}

export function exhaustive(kind: 'a' | 'b'): number {
  switch (kind) {
    case 'a':
      return 1;
  }
  return 0;
}
