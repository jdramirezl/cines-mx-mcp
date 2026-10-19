/**
 * Simple pacing queue: one request at a time, at least `minIntervalMs` apart,
 * plus in-flight de-duplication by key. Low volume by design.
 */
export class Pacer {
  private tail: Promise<unknown> = Promise.resolve();
  private last = Number.NEGATIVE_INFINITY;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  run<T>(key: string | undefined, task: () => Promise<T>): Promise<T> {
    if (key) {
      const hit = this.inflight.get(key);
      if (hit) return hit as Promise<T>;
    }
    const p = this.tail.then(async () => {
      const wait = this.last + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      return task();
    });
    this.tail = p.catch(() => undefined);
    if (key) {
      this.inflight.set(key, p);
      p.finally(() => this.inflight.delete(key)).catch(() => undefined);
    }
    return p;
  }
}
