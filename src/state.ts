export const running = new Set<string>();
export const queued = new Set<string>();

const expectedRemovals = new Map<string, number>();
export function expectRemoval(name: string) { expectedRemovals.set(name, Date.now()); }
export function wasExpected(name: string): boolean {
  const t = expectedRemovals.get(name);
  expectedRemovals.delete(name);
  return !!t && Date.now() - t < 30_000;
}
