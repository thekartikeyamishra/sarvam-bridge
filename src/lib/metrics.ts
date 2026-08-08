/**
 * Metrics.
 *
 * Prometheus text exposition, hand-rolled rather than pulled from a client
 * library. The surface we need is a handful of counters and one histogram, and
 * avoiding the dependency keeps the install small and the supply chain narrow
 * for something that runs next to a production API key.
 */

export interface HistogramSnapshot {
  readonly buckets: ReadonlyMap<number, number>;
  readonly sum: number;
  readonly count: number;
}

const LATENCY_BUCKETS = [
  0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
] as const;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histSum = new Map<string, number>();
  private readonly histCount = new Map<string, number>();
  private readonly histBuckets = new Map<string, Map<number, number>>();
  readonly startedAt = Date.now();

  private static series(name: string, labels: Record<string, string>): string {
    const parts = Object.entries(labels)
      .filter(([, v]) => v !== undefined && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`);
    return parts.length > 0 ? `${name}{${parts.join(",")}}` : name;
  }

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = Metrics.series(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(
    name: string,
    seconds: number,
    labels: Record<string, string> = {},
  ): void {
    const key = Metrics.series(name, labels);
    this.histSum.set(key, (this.histSum.get(key) ?? 0) + seconds);
    this.histCount.set(key, (this.histCount.get(key) ?? 0) + 1);

    let buckets = this.histBuckets.get(key);
    if (!buckets) {
      buckets = new Map<number, number>();
      for (const b of LATENCY_BUCKETS) buckets.set(b, 0);
      this.histBuckets.set(key, buckets);
    }
    for (const b of LATENCY_BUCKETS) {
      if (seconds <= b) buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
  }

  /** Render the full registry in Prometheus text format. */
  render(extra: Record<string, number> = {}): string {
    const lines: string[] = [];

    lines.push("# HELP sarvam_bridge_uptime_seconds Process uptime.");
    lines.push("# TYPE sarvam_bridge_uptime_seconds gauge");
    lines.push(
      `sarvam_bridge_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(3)}`,
    );

    const counterNames = new Set<string>();
    for (const key of this.counters.keys()) {
      counterNames.add(key.split("{")[0] ?? key);
    }
    for (const name of [...counterNames].sort()) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of this.counters) {
        if ((key.split("{")[0] ?? key) === name) lines.push(`${key} ${value}`);
      }
    }

    for (const [key, buckets] of this.histBuckets) {
      const base = key.split("{")[0] ?? key;
      const labelPart = key.includes("{")
        ? key.slice(key.indexOf("{") + 1, key.lastIndexOf("}"))
        : "";
      lines.push(`# TYPE ${base} histogram`);
      let cumulative = 0;
      for (const b of LATENCY_BUCKETS) {
        cumulative = buckets.get(b) ?? 0;
        const labels = labelPart ? `${labelPart},le="${b}"` : `le="${b}"`;
        lines.push(`${base}_bucket{${labels}} ${cumulative}`);
      }
      const count = this.histCount.get(key) ?? 0;
      const infLabels = labelPart ? `${labelPart},le="+Inf"` : 'le="+Inf"';
      lines.push(`${base}_bucket{${infLabels}} ${count}`);
      lines.push(
        `${base}_sum${labelPart ? `{${labelPart}}` : ""} ${(this.histSum.get(key) ?? 0).toFixed(6)}`,
      );
      lines.push(`${base}_count${labelPart ? `{${labelPart}}` : ""} ${count}`);
    }

    for (const [name, value] of Object.entries(extra).sort()) {
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    }

    return `${lines.join("\n")}\n`;
  }

  reset(): void {
    this.counters.clear();
    this.histSum.clear();
    this.histCount.clear();
    this.histBuckets.clear();
  }
}
