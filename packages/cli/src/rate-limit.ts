/**
 * In-memory sliding-window rate limiter for login endpoints. Per-process;
 * on serverless that means per-instance, which still blunts brute force
 * (the WordPress-parity bar) without needing shared storage.
 */

/** Hard ceiling on tracked keys; see sweep(). */
const MAX_KEYS = 50_000;
/** How much the map may grow between sweeps (keeps sweep cost amortized). */
const SWEEP_STRIDE = 1_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private nextSweep = 10_000;

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Record an attempt; returns false when the key is over the limit. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size >= this.nextSweep) this.sweep(cutoff);
    return true;
  }

  /**
   * Bound the map. Runs only every SWEEP_STRIDE insertions past 10k keys, so
   * a key-spraying attacker can't make every request pay a full scan.
   *
   * First drop keys whose attempts all expired; if the map is still over
   * MAX_KEYS (unique-key spray inside one window, e.g. forged
   * X-Forwarded-For values), evict oldest-inserted. That lets a determined
   * attacker cycle their own key out, but per-instance limits are already
   * best-effort (documented in SECURITY.md); unbounded memory is the
   * strictly worse failure.
   */
  private sweep(cutoff: number): void {
    for (const [k, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(k);
    }
    if (this.hits.size > MAX_KEYS) {
      for (const k of this.hits.keys()) {
        if (this.hits.size <= MAX_KEYS) break;
        this.hits.delete(k);
      }
    }
    this.nextSweep = Math.max(10_000, this.hits.size + SWEEP_STRIDE);
  }
}

/**
 * Best-effort client key from X-Forwarded-For, else a constant.
 *
 * Uses the LAST hop, not the first. X-Forwarded-For is built by each proxy
 * APPENDING the address it saw, so the first value is whatever the original
 * request claimed (fully attacker-controlled on a direct request) while the
 * last value is the one your own edge/host appended and the client cannot
 * forge. Keying on the first hop lets an attacker bypass rate limiting
 * entirely by sending a new made-up value on every request.
 *
 * Still best-effort: some hosts put the trustworthy IP elsewhere (e.g. a
 * dedicated header) or behind more hops than expected. This blunts casual
 * brute force; it isn't a substitute for host-level rate limiting on a
 * public deployment.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (!fwd) return "direct";
  const hops = fwd.split(",").map((h) => h.trim());
  return hops[hops.length - 1] || "direct";
}
