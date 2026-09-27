// Glitch profiler — frame CPU scopes, counters, budgets, snapshots.
// Pure data + math: the clock is injectable so tests drive it with fake
// time. Zero DOM/GL dependencies; the engine wires it in core/engine.ts
// (update/render scopes + renderer-stat gauges) and main.ts shows one
// line of it in the HUD. Never throws inside the frame path: stray end()
// calls return -1 instead of interrupting the game loop.

export interface ScopeStat {
  label: string;
  calls: number; // total calls in history
  totalMs: number; // summed inclusive time in history
  avgMs: number; // mean per frame over recorded frames
  maxMs: number; // worst single frame in history
}

export interface CounterStat {
  name: string;
  avg: number; // mean per frame over recorded frames
  max: number; // worst single frame in history
}

export interface ProfilerSnapshot {
  frames: number; // frames in history
  fps: number; // estimated from mean frame wall time (0 when empty)
  frameMsAvg: number;
  frameMsMax: number;
  breaches: number; // frames over budget in history
  scopes: ScopeStat[];
  counters: CounterStat[];
}

interface OpenScope {
  label: string;
  start: number;
}

interface FrameScopes {
  totals: Map<string, number>;
  calls: Map<string, number>;
}

export class FrameProfiler {
  frameBudgetMs = 1000 / 60;
  maxHistory = 120;

  private stack: OpenScope[] = [];
  private frameScopes: FrameScopes = { totals: new Map(), calls: new Map() };
  private frameCounters = new Map<string, number>();
  private frameGauges = new Map<string, number>();
  private scopeHistory: FrameScopes[] = [];
  private counterHistory: Map<string, number>[] = [];
  private frameWall: number[] = []; // wall ms per recorded frame
  private frameStart: number;
  private breaches = 0;

  constructor(private now: () => number = () => performance.now()) {
    this.frameStart = this.now();
  }

  // --- scopes (safe to nest; safe to mismatch) ---

  begin(label: string): void {
    this.stack.push({ label, start: this.now() });
  }

  // Closes the most recent scope; returns its ms, or -1 when unbalanced.
  end(): number {
    const open = this.stack.pop();
    if (!open) return -1;
    const dt = Math.max(0, this.now() - open.start);
    this.frameScopes.totals.set(open.label, (this.frameScopes.totals.get(open.label) ?? 0) + dt);
    this.frameScopes.calls.set(open.label, (this.frameScopes.calls.get(open.label) ?? 0) + 1);
    return dt;
  }

  // Convenience: time a function (sync) inside a scope, returning its value.
  scoped<T>(label: string, fn: () => T): T {
    this.begin(label);
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  get depth(): number {
    return this.stack.length;
  }

  // --- per-frame values ---

  // Adds to a same-frame accumulator (e.g. spawned particles).
  counter(name: string, v = 1): void {
    this.frameCounters.set(name, (this.frameCounters.get(name) ?? 0) + v);
  }

  // Last-wins per frame (e.g. renderer.stats.drawn, already a frame total).
  gauge(name: string, v: number): void {
    if (Number.isFinite(v)) this.frameGauges.set(name, v);
  }

  // Rolls the current frame into history. Call once per presented frame.
  frame(): void {
    const wall = Math.max(0, this.now() - this.frameStart);
    this.frameStart = this.now();
    // Abandon scopes left open across the boundary (never leak the stack).
    this.stack.length = 0;
    this.scopeHistory.push(this.frameScopes);
    if (this.scopeHistory.length > this.maxHistory) this.scopeHistory.shift();
    const merged = new Map(this.frameCounters);
    for (const [k, v] of this.frameGauges) merged.set(k, v);
    this.counterHistory.push(merged);
    if (this.counterHistory.length > this.maxHistory) this.counterHistory.shift();
    this.frameWall.push(wall);
    if (this.frameWall.length > this.maxHistory) this.frameWall.shift();
    if (wall > this.frameBudgetMs) this.breaches++;
    this.frameScopes = { totals: new Map(), calls: new Map() };
    this.frameCounters = new Map();
    this.frameGauges = new Map();
  }

  get frames(): number {
    return this.scopeHistory.length;
  }

  get breachCount(): number {
    return this.breaches;
  }

  reset(): void {
    this.stack.length = 0;
    this.frameScopes = { totals: new Map(), calls: new Map() };
    this.frameCounters = new Map();
    this.frameGauges = new Map();
    this.scopeHistory.length = 0;
    this.counterHistory.length = 0;
    this.frameWall.length = 0;
    this.breaches = 0;
    this.frameStart = this.now();
  }

  snapshot(): ProfilerSnapshot {
    const n = this.scopeHistory.length;
    const scopes = new Map<string, { calls: number; total: number; max: number }>();
    for (const f of this.scopeHistory) {
      for (const [label, total] of f.totals) {
        const s = scopes.get(label) ?? { calls: 0, total: 0, max: 0 };
        s.calls += f.calls.get(label) ?? 0;
        s.total += total;
        s.max = Math.max(s.max, total);
        scopes.set(label, s);
      }
    }
    const scopeStats: ScopeStat[] = [...scopes.entries()].map(([label, s]) => ({
      label,
      calls: s.calls,
      totalMs: s.total,
      avgMs: n > 0 ? s.total / n : 0,
      maxMs: s.max,
    }));
    scopeStats.sort((a, b) => b.totalMs - a.totalMs);
    const counters = new Map<string, { total: number; max: number }>();
    for (const f of this.counterHistory) {
      for (const [name, v] of f) {
        const c = counters.get(name) ?? { total: 0, max: -Infinity };
        c.total += v;
        c.max = Math.max(c.max, v);
        counters.set(name, c);
      }
    }
    const counterStats: CounterStat[] = [...counters.entries()].map(([name, c]) => ({
      name,
      avg: n > 0 ? c.total / n : 0,
      max: c.max,
    }));
    counterStats.sort((a, b) => b.max - a.max);
    const wallTotal = this.frameWall.reduce((a, b) => a + b, 0);
    const wallMax = this.frameWall.reduce((a, b) => Math.max(a, b), 0);
    const avg = n > 0 ? wallTotal / n : 0;
    return {
      frames: n,
      fps: avg > 0 ? 1000 / avg : 0,
      frameMsAvg: avg,
      frameMsMax: wallMax,
      breaches: this.breaches,
      scopes: scopeStats,
      counters: counterStats,
    };
  }

  // One-line HUD/console summary: top scope + frame average.
  formatLine(s: ProfilerSnapshot = this.snapshot(), maxScopes = 3): string {
    const top = s.scopes.slice(0, maxScopes).map((x) => `${x.label} ${x.avgMs.toFixed(2)}ms`).join(" ");
    return `${s.fps.toFixed(0)}fps ${s.frameMsAvg.toFixed(2)}ms${top ? " " + top : ""}${s.breaches > 0 ? ` !${s.breaches} over` : ""}`;
  }
}
