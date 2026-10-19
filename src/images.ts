/** In-memory, short-lived PNG store served at /images/<id>.png (loopback only). */
import { randomBytes } from "node:crypto";

export class ImageStore {
  private readonly items = new Map<string, { at: number; png: Buffer }>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly max = 50,
    private readonly now: () => number = Date.now,
  ) {}

  put(png: Buffer): string {
    this.sweep();
    const id = randomBytes(12).toString("hex");
    this.items.set(id, { at: this.now(), png });
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    return id;
  }

  get(id: string): Buffer | undefined {
    if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
    this.sweep();
    return this.items.get(id)?.png;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.items) if (t - v.at > this.ttlMs) this.items.delete(k);
  }
}
