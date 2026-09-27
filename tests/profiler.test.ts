import { describe, expect, it } from "vitest";
import { FrameProfiler } from "../src/debug/profiler.js";

function fakeClock() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function framed(p: FrameProfiler, clock: { advance: (ms: number) => void }, wallMs: number, body: () => void) {
  body();
  clock.advance(wallMs);
  p.frame();
}

describe("FrameProfiler scopes", () => {
  it("times scopes with an injected clock", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.begin("update");
    c.advance(4);
    expect(p.end()).toBeCloseTo(4);
    p.frame();
    const s = p.snapshot();
    expect(s.frames).toBe(1);
    expect(s.scopes).toHaveLength(1);
    expect(s.scopes[0]).toMatchObject({ label: "update", calls: 1 });
    expect(s.scopes[0].avgMs).toBeCloseTo(4);
    expect(s.scopes[0].maxMs).toBeCloseTo(4);
  });

  it("supports nesting and repeated calls", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.begin("outer");
    c.advance(2);
    p.begin("inner");
    c.advance(3);
    p.end();
    p.begin("inner");
    c.advance(1);
    p.end();
    c.advance(1);
    p.end();
    expect(p.depth).toBe(0);
    p.frame();
    const byLabel = new Map(p.snapshot().scopes.map((s) => [s.label, s]));
    expect(byLabel.get("outer")!.avgMs).toBeCloseTo(7);
    expect(byLabel.get("inner")!.calls).toBe(2);
    expect(byLabel.get("inner")!.totalMs).toBeCloseTo(4);
  });

  it("never throws on unbalanced end()", () => {
    const p = new FrameProfiler(fakeClock().now);
    expect(p.end()).toBe(-1);
    p.frame();
    expect(p.snapshot().scopes).toEqual([]);
  });

  it("scoped() returns values and always closes", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    const v = p.scoped("work", () => { c.advance(2); return 42; });
    expect(v).toBe(42);
    expect(p.depth).toBe(0);
    expect(() => p.scoped("boom", () => { throw new Error("x"); })).toThrow();
    expect(p.depth).toBe(0);
  });

  it("abandons scopes left open across frame()", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.begin("leak");
    c.advance(5);
    p.frame();
    expect(p.depth).toBe(0);
    expect(p.frames).toBe(1);
  });
});

describe("FrameProfiler counters", () => {
  it("accumulates counters and last-wins gauges per frame", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.counter("spawned");
    p.counter("spawned", 4);
    p.gauge("drawn", 10);
    p.gauge("drawn", 12);
    p.frame();
    p.gauge("drawn", 7);
    p.frame();
    const byName = new Map(p.snapshot().counters.map((x) => [x.name, x]));
    expect(byName.get("spawned")!).toMatchObject({ avg: 2.5, max: 5 });
    expect(byName.get("drawn")!).toMatchObject({ avg: 9.5, max: 12 });
  });

  it("ignores non-finite gauges", () => {
    const p = new FrameProfiler(fakeClock().now);
    p.gauge("x", NaN);
    p.frame();
    expect(p.snapshot().counters).toEqual([]);
  });
});

describe("FrameProfiler history and budget", () => {
  it("estimates fps from wall time and counts breaches", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.frameBudgetMs = 10;
    framed(p, c, 20, () => undefined); // breach
    framed(p, c, 5, () => undefined); // ok
    const s = p.snapshot();
    expect(s.frames).toBe(2);
    expect(s.breaches).toBe(1);
    expect(s.frameMsAvg).toBeCloseTo(12.5);
    expect(s.frameMsMax).toBeCloseTo(20);
    expect(s.fps).toBeCloseTo(1000 / 12.5);
  });

  it("caps history at maxHistory", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.maxHistory = 4;
    for (let i = 0; i < 10; i++) { c.advance(16); p.frame(); }
    expect(p.frames).toBe(4);
  });

  it("tracks per-scope max across frames", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    framed(p, c, 16, () => { p.begin("ai"); c.advance(2); p.end(); });
    framed(p, c, 16, () => { p.begin("ai"); c.advance(9); p.end(); });
    const s = p.snapshot().scopes[0];
    expect(s.avgMs).toBeCloseTo(5.5);
    expect(s.maxMs).toBeCloseTo(9);
  });

  it("sorts scopes by total time descending", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.begin("small"); c.advance(1); p.end();
    p.begin("big"); c.advance(8); p.end();
    p.frame();
    const labels = p.snapshot().scopes.map((s) => s.label);
    expect(labels).toEqual(["big", "small"]);
  });

  it("reset() clears everything", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    p.begin("a"); c.advance(3); p.end();
    p.counter("n", 2);
    p.frame();
    p.reset();
    const s = p.snapshot();
    expect(s.frames).toBe(0);
    expect(s.fps).toBe(0);
    expect(s.scopes).toEqual([]);
    expect(s.counters).toEqual([]);
    expect(p.breachCount).toBe(0);
  });
});

describe("FrameProfiler reporting", () => {
  it("snapshots survive a JSON round-trip", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    framed(p, c, 16, () => {
      p.begin("render"); c.advance(6); p.end();
      p.gauge("drawn", 120);
    });
    const back = JSON.parse(JSON.stringify(p.snapshot()));
    expect(back.frames).toBe(1);
    expect(back.scopes[0].label).toBe("render");
    expect(back.counters[0]).toMatchObject({ name: "drawn", avg: 120, max: 120 });
  });

  it("formatLine summarizes fps, frame ms, and top scopes", () => {
    const c = fakeClock();
    const p = new FrameProfiler(c.now);
    framed(p, c, 20, () => { p.begin("render"); c.advance(12); p.end(); });
    const line = p.formatLine();
    expect(line).toContain("31fps"); // wall = 12ms scope + 20ms idle
    expect(line).toContain("32.00ms");
    expect(line).toContain("render 12.00ms");
    expect(line).toContain("over"); // 32ms wall > 16.67ms budget
  });

  it("formatLine is empty-safe", () => {
    const p = new FrameProfiler(fakeClock().now);
    expect(p.formatLine()).toContain("0fps");
  });
});
