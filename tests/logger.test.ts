import { describe, expect, it } from "vitest";
import { CommandRegistry, LEVEL_RANK, LOG_LEVELS, Logger, tokenize, type LogRecord } from "../src/debug/logger.js";
import { registerDefaultCommands } from "../src/debug/commands.js";
import { createBuildSettingsService } from "../src/core/buildservice.js";
import { World } from "../src/ecs/world.js";
import { makeTransform } from "../src/ecs/components.js";

function clock(start = 0) {
  let t = start;
  return () => {
    t += 1;
    return t;
  };
}

function silentLogger(opts = {}) {
  return new Logger({ mirror: false, clock: clock(), ...opts });
}

describe("Logger basics", () => {
  it("records levels, system tags and sequence numbers", () => {
    const l = silentLogger();
    l.log("core", "started");
    l.info("core", "info line");
    l.warn("physics", "tunnel");
    l.error("script", "boom", { code: 7 });
    expect(l.size).toBe(4);
    const h = l.history();
    expect(h[0].message).toBe("boom");
    expect(h[0].data).toEqual({ code: 7 });
    expect(h[1].system).toBe("physics");
    expect([...h].reverse().map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("only keeps data on warn/error", () => {
    const l = silentLogger();
    l.write("log", "s", "plain", { drop: true });
    expect(l.history()[0].data).toBeUndefined();
  });

  it("captures Error stacks and derives data", () => {
    const l = silentLogger();
    l.error("physics", "step failed", undefined, new TypeError("bad shape"));
    const r = l.history()[0];
    expect(r.stack).toContain("TypeError");
    expect(r.data).toMatchObject({ name: "TypeError", message: "bad shape" });
    l.error("x", "string err", undefined, "raw stack");
    expect(l.history()[0].stack).toBe("raw stack");
  });

  it("filters by level, system and text", () => {
    const l = silentLogger();
    l.log("a", "alpha");
    l.warn("b", "beta");
    l.error("a", "gamma");
    expect(l.history({ level: "warn" })).toHaveLength(2);
    expect(l.history({ system: "a" })).toHaveLength(2);
    expect(l.history({ search: "BET" })).toHaveLength(1);
    expect(l.history({ search: "zzz" })).toHaveLength(0);
    expect(l.countOf("error")).toBe(1);
    expect(l.countOf()).toBe(3);
  });

  it("honours the minimum level", () => {
    const l = silentLogger();
    l.setMinLevel("warn");
    l.log("s", "dropped");
    l.info("s", "dropped");
    l.warn("s", "kept");
    expect(l.size).toBe(1);
  });

  it("folds repeated identical records and keeps the count", () => {
    const l = silentLogger({ capacity: 5 });
    for (let i = 0; i < 4; i++) l.warn("physics", "same message");
    expect(l.size).toBe(1);
    expect(l.history()[0].count).toBe(4);
    l.warn("physics", "different");
    expect(l.size).toBe(2);
  });

  it("bounds the buffer and stays correct after eviction", () => {
    const l = silentLogger({ capacity: 3 });
    l.log("s", "a");
    l.log("s", "b");
    l.log("s", "c");
    l.log("s", "d");
    expect(l.size).toBe(3);
    // Folding must still work after the shift.
    l.log("s", "d");
    expect(l.size).toBe(3);
    expect(l.history().map((r) => r.message)).toEqual(["d", "c", "b"]);
  });

  it("pushes to sinks and stops after removal", () => {
    const l = silentLogger();
    const seen: LogRecord[] = [];
    const off = l.addSink((r) => seen.push(r));
    l.info("s", "one");
    off();
    l.info("s", "two");
    expect(seen).toHaveLength(1);
  });

  it("a throwing sink cannot break the caller", () => {
    const l = silentLogger();
    l.addSink(() => {
      throw new Error("sink is broken");
    });
    expect(() => l.log("s", "still fine")).not.toThrow();
    expect(l.size).toBe(1);
  });

  it("rejects nothing but never throws for odd input", () => {
    const l = silentLogger();
    expect(() => l.write("nope" as never, "s", "m")).not.toThrow();
    l.clear();
    expect(l.size).toBe(0);
  });

  it("exposes a sane level order", () => {
    expect(LOG_LEVELS).toEqual(["log", "info", "warn", "error"]);
    expect(LEVEL_RANK.log).toBeLessThan(LEVEL_RANK.error);
  });
});

describe("tokenize", () => {
  it("splits on whitespace and honours quotes", () => {
    expect(tokenize("a b   c")).toEqual(["a", "b", "c"]);
    expect(tokenize('say "hello world" now')).toEqual(["say", "hello world", "now"]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
});

describe("CommandRegistry", () => {
  it("runs commands with arguments and reports unknown ones", () => {
    const reg = new CommandRegistry();
    reg.register("echo", (args) => ({ ok: true, output: args.toUpperCase() }), ["say"]);
    expect(reg.run("echo hi there").output).toBe("HI THERE");
    expect(reg.run("say hi").ok).toBe(true);
    expect(reg.run("nope").ok).toBe(false);
    expect(reg.run("nope").output).toContain("unknown command");
    expect(reg.run("  ").ok).toBe(false);
    expect(reg.names()).toEqual(["echo", "say"]);
  });

  it("catches handler throws instead of propagating", () => {
    const reg = new CommandRegistry();
    reg.register("boom", () => {
      throw new Error("nope");
    });
    const r = reg.run("boom");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("threw");
  });
});

describe("default commands", () => {
  function harness() {
    const world = new World();
    const e = world.create();
    world.add(e, "transform", makeTransform(1, 2, 3));
    // A minimal stand-in for Engine: the commands only touch these fields.
    const engine = {
      log: silentLogger(),
      quality: {
        level: "high" as const,
        config: {
          level: "high" as const, pixelScale: 1, fpsLimit: 60, shadowSize: 2048,
          shadowDistance: 42, shadowSoftness: 1, viewDistance: 240, fogEnabled: true,
          postEnabled: true, pointLights: 4, textureMaxSize: 2048, particles: 256,
          gamma: 1, tonemap: "none" as const, exposure: 1,
        },
        applyPreset(l: string) { (this.config as { level: string }).level = l; this.level = l as never; },
        save: () => true,
      },
      profiler: {
        snapshot: () => ({
          frames: 10, fps: 60, frameMsAvg: 16, frameMsMax: 20, breaches: 0,
          scopes: [{ label: "render", calls: 10, totalMs: 40, avgMs: 4, maxMs: 6 }],
          counters: [],
        }),
      },
      renderer: {
        stats: { total: 5, drawn: 3, culled: 2, instancedDraws: 1, shadowDraws: 1, postDraws: 0 },
        pointLights: [1, 2], spotLights: [1],
        shadows: { enabled: true, size: 2048, distance: 42, strength: 0.7 },
        camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, fovY: 1 },
      },
      assets: { count: 9 },
      build: createBuildSettingsService(),
    };
    const reg = registerDefaultCommands(new CommandRegistry(), engine as never, world);
    return { reg, engine, world, entity: e };
  }

  it("help lists commands", () => {
    const { reg } = harness();
    const r = reg.run("help");
    expect(r.ok).toBe(true);
    for (const n of ["stats", "quality", "errors", "shadows", "entities", "build"]) expect(r.output).toContain(n);
  });

  it("build shows the settings and applies valid changes", () => {
    const { reg } = harness();
    const show = reg.run("build");
    expect(show.ok).toBe(true);
    expect(show.output).toContain("win/portable");
    expect(show.output).toContain("appId");
    expect(reg.run("build name Night Shift").ok).toBe(true);
    expect(reg.run("build").output).toContain("Night Shift");
    expect(reg.run("build version 0.9.0").ok).toBe(true);
    expect(reg.run("build version v9").ok).toBe(false);
    expect(reg.run("build target linux").ok).toBe(true);
    expect(reg.run("build").output).toContain("linux/AppImage");
    expect(reg.run("build target playstation").ok).toBe(false);
    expect(reg.run("build name").ok).toBe(false);
    expect(reg.run("build nonsense").ok).toBe(false);
    expect(reg.run("build reset").ok).toBe(true);
  });

  it("stats reports real engine numbers", () => {
    const { reg } = harness();
    const r = reg.run("stats");
    expect(r.output).toContain("culled 2");
    expect(r.output).toContain("entities 1");
    expect(r.output).toContain("assets 9");
    expect(r.output).toContain("render avg 4.00ms");
  });

  it("quality reads and changes the preset", () => {
    const { reg, engine } = harness();
    expect(reg.run("quality").output).toContain("level high");
    expect(reg.run("quality low").ok).toBe(true);
    expect(engine.quality.level).toBe("low");
    expect(reg.run("quality kraken").ok).toBe(false);
  });

  it("shadows toggles and resizes", () => {
    const { reg, engine } = harness();
    expect(reg.run("shadows off").output).toContain("off");
    expect(engine.renderer.shadows.enabled).toBe(false);
    expect(reg.run("shadows on").output).toContain("on");
    expect(reg.run("shadows size 1024").ok).toBe(true);
    expect(engine.renderer.shadows.size).toBe(1024);
    expect(reg.run("shadows size -4").ok).toBe(false);
  });

  it("log writes into the log buffer and errors lists them", () => {
    const { reg, engine } = harness();
    expect(reg.run("log warn disk full").ok).toBe(true);
    expect(engine.log.history({ level: "warn" })).toHaveLength(1);
    expect(reg.run("errors").output).toContain("no errors");
    engine.log.error("physics", "kaboom");
    expect(reg.run("errors").output).toContain("kaboom");
    expect(reg.run("log").ok).toBe(false);
  });

  it("fov validates and pos reports the camera", () => {
    const { reg, engine } = harness();
    expect(reg.run("fov 60").ok).toBe(true);
    expect(engine.renderer.camera.fovY).toBeCloseTo(Math.PI / 3, 5);
    expect(reg.run("fov 500").ok).toBe(false);
    expect(reg.run("pos").output).toContain("camera 1.00");
  });

  it("entities lists and filters", () => {
    const { reg, world, entity } = harness();
    expect(reg.run("entities").output).toContain("1 entities");
    expect(reg.run(`entities ${entity}`).output).toContain("matching");
    expect(reg.run("entities 999").output).toContain("0 entities");
  });

  it("clear empties the log", () => {
    const { reg, engine } = harness();
    engine.log.error("x", "y");
    reg.run("clear");
    expect(engine.log.size).toBe(0);
  });
});
