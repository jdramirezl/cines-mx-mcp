/** Small TTL cache with single-flight loading and stale fallback on errors. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();
  private readonly loading = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 200,
  ) {}

  async get(key: string, load: () => Promise<V>, opts: { staleOnError?: boolean } = {}): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const running = this.loading.get(key);
    if (running) return running;
    const p = load()
      .then((value) => {
        this.entries.set(key, { at: this.now(), value });
        if (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest !== undefined) this.entries.delete(oldest);
        }
        return value;
      })
      .catch((e: unknown) => {
        if (opts.staleOnError !== false && hit) return hit.value;
        throw e;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}
