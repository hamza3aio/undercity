// Glitch standard console commands — the commands a game gets for free
// (Phase 19 / command-palette groundwork). Each command is a thin adapter
// over real engine state; nothing here is cosmetic.

import type { Engine } from "../core/engine.js";
import type { World } from "../ecs/world.js";
import { CommandRegistry, type CommandResult } from "./logger.js";
import { QUALITY_LEVELS } from "../core/quality.js";

export interface DefaultCommandDeps {
  engine: Engine;
  world: World;
  /** Present when the game runs a net session (server or client). */
  net?: unknown;
}

export function registerDefaultCommands(reg: CommandRegistry, engine: Engine, world: World, deps: DefaultCommandDeps = { engine, world }): CommandRegistry {
  reg.register("help", () => ({
    ok: true,
    output: reg.names().filter((n, i, a) => a.indexOf(n) === i).join(", "),
  }));

  reg.register("clear", () => {
    engine.log.clear();
    return { ok: true, output: "log cleared" };
  });

  // Phase 20: packaging settings. Read-only display plus a few setters;
  // it never starts a build (that is an npm script, not a runtime action).
  reg.register("build", (args) => {
    const svc = engine.build;
    const a = args.trim();
    const s = svc.settings;
    if (a === "") {
      return {
        ok: true,
        output: [
          svc.summary(),
          `  appId ${s.appId} · out ${s.outDir} · icon ${s.icon ?? "default"}`,
          `  host ${svc.host.platform}/${svc.host.arch} electron ${svc.host.electron} chrome ${svc.host.chrome} node ${svc.host.node}`,
          "  set: build name <text> | build version <x.y.z> | build target win|linux|mac | build reset",
        ].join("\n"),
      };
    }
    const [key, ...rest] = a.split(/\s+/);
    const value = rest.join(" ");
    switch (key) {
      case "name": {
        if (!value) return { ok: false, output: "usage: build name <product name>" };
        return { ok: true, output: `product name = ${svc.save({ productName: value }).productName}` };
      }
      case "version": {
        if (!value) return { ok: false, output: "usage: build version <x.y.z>" };
        const saved = svc.save({ version: value });
        return saved.version === value
          ? { ok: true, output: `version = ${saved.version}` }
          : { ok: false, output: `"${value}" is not a valid version` };
      }
      case "target": {
        const saved = svc.save({ platforms: [value] as never });
        if (saved.platforms[0] !== value.toLowerCase()) {
          return { ok: false, output: `unknown target "${value}" (use win, linux or mac)` };
        }
        return { ok: true, output: `platforms = ${saved.platforms.join(", ")}\n${svc.summary()}` };
      }
      case "reset":
        svc.reset();
        return { ok: true, output: `reset\n${svc.summary()}` };
      default:
        return { ok: false, output: "usage: build [name <text> | version <x.y.z> | target <platform> | reset]" };
    }
  });

  reg.register("stats", () => {
    const p = engine.profiler.snapshot();
    const r = engine.renderer.stats;
    return {
      ok: true,
      output: [
        `frame ${p.frameMsAvg.toFixed(2)}ms (max ${p.frameMsMax.toFixed(2)}ms) ~${p.fps.toFixed(0)}fps over ${p.frames} frames`,
        p.scopes.map((s) => `  ${s.label} avg ${s.avgMs.toFixed(2)}ms max ${s.maxMs.toFixed(2)}ms x${s.calls}`).join("\n"),
        `render drawn ${r.drawn}/${r.total} culled ${r.culled} inst ${r.instancedDraws} shadow ${r.shadowDraws} post ${r.postDraws}`,
        `lod reduced ${r.lodDraws} hidden ${r.lodCulled}`,
        `world entities ${world.count()} assets ${engine.assets.count} lights ${engine.renderer.pointLights.length}+${engine.renderer.spotLights.length}s`,
      ].join("\n"),
    };
  }, ["st"]);

  reg.register("entities", (args) => {
    const q = args.trim();
    const list = world.query("transform");
    const filtered = q ? list.filter((e) => String(e) === q) : list;
    const head = filtered.slice(0, 20);
    return {
      ok: true,
      output: `${filtered.length} entities${q ? ` matching "${q}"` : ""}\n${head.map((e) => {
        const t = world.get<{ position: { x: number; y: number; z: number } }>(e, "transform");
        const p = t ? `${t.position.x.toFixed(1)},${t.position.y.toFixed(1)},${t.position.z.toFixed(1)}` : "?";
        return `  #${e} @ ${p}`;
      }).join("\n")}${filtered.length > head.length ? `\n  … ${filtered.length - head.length} more` : ""}`,
    };
  }, ["ls"]);

  reg.register("plugins", (args) => {
    const sub = args.trim().toLowerCase();
    if (sub === "reload" || sub === "unload" || sub.startsWith("unload ")) {
      const name = args.trim().split(/\s+/)[1] ?? "";
      if (!name) return { ok: false, output: "usage: plugins unload <name>" };
      const n = engine.plugins.unload(name, world);
      return { ok: n > 0, output: n > 0 ? `unloaded "${name}" (${n} extensions removed)` : `"${name}" was not loaded` };
    }
    const list = engine.plugins.loaded;
    if (list.length === 0) return { ok: true, output: "no plugins loaded" };
    return {
      ok: true,
      output: [
        `${list.length} plugins, ${engine.plugins.registry.size} extensions, ${engine.plugins.systemCount} systems`,
        ...list.map((p) => `  ${p.manifest.name}@${p.manifest.version} — ${p.extensions} extensions${p.manifest.description ? ` (${p.manifest.description})` : ""}`),
      ].join("\n"),
    };
  });

  reg.register("imports", (args) => {
    const sub = args.trim().toLowerCase();
    const pipe = engine.imports;
    if (sub === "pump") {
      const n = pipe.pump(50);
      return { ok: true, output: `processed ${n} job(s), ${pipe.pending} pending` };
    }
    if (sub === "run") {
      const n = pipe.runAll();
      return { ok: true, output: `processed ${n} job(s), ${pipe.pending} pending` };
    }
    const jobs = pipe.jobs.slice(-10).reverse();
    if (jobs.length === 0) return { ok: true, output: "import queue empty (drop .obj/.gltf/.glb onto the asset browser)" };
    return {
      ok: true,
      output: [
        `${pipe.pending} pending · ${engine.assets.count} assets in the database`,
        ...jobs.map((j) => `  ${j.name} — ${j.status}${j.error ? `: ${j.error}` : ` ${Math.round(j.progress * 100)}%`}`),
      ].join("\n"),
    };
  });

  reg.register("net", (args) => {
    const sub = args.trim().toLowerCase();
    if (!deps.net) return { ok: false, output: "no net session running in this build" };
    const st = (deps.net as { state: () => { role: string; peers: number; spawned: number; replicas: number; systems: number; rttMs: number } }).state();
    if (sub === "server") return { ok: true, output: `host — ${st.spawned} entities replicated to ${st.peers} peer(s)` };
    if (sub === "client") return { ok: true, output: `client — ${st.replicas} replica(s), ${st.peers} peer(s), ${st.rttMs}ms simulated RTT` };
    if (sub === "" || sub === "status") {
      return {
        ok: true,
        output: [
          `role ${st.role} · ${st.peers} peer(s) · ${st.spawned} spawned · ${st.replicas} replicas · ${st.systems} net system(s)`,
          st.rttMs > 0 ? `simulated RTT ${st.rttMs}ms (replicas interpolate over a 100ms buffer)` : "",
        ].join("\n"),
      };
    }
    return { ok: false, output: "usage: net [status|server|client]" };
  });

  reg.register("quality", (args) => {
    const want = args.trim().toLowerCase();
    if (want.length > 0) {
      if (!(QUALITY_LEVELS as string[]).includes(want)) {
        return { ok: false, output: `unknown level "${want}" (try: ${QUALITY_LEVELS.join(", ")})` };
      }
      engine.quality.applyPreset(want as (typeof QUALITY_LEVELS)[number]);
      engine.quality.save();
    }
    const c = engine.quality.config;
    return {
      ok: true,
      output: `level ${c.level} · res ${Math.round(c.pixelScale * 100)}% · fps ${c.fpsLimit || "uncapped"} · shadows ${c.shadowSize || "off"} · view ${c.viewDistance} · post ${c.postEnabled ? "on" : "off"} · tonemap ${c.tonemap} gamma ${c.gamma}`,
    };
  });

  reg.register("shadows", (args) => {
    const s = engine.renderer.shadows;
    const toks = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sub = toks[0] ?? "";
    if (sub === "on" || sub === "off") s.enabled = sub === "on";
    else if (sub === "size") {
      const n = Number(toks[1]);
      if (!Number.isFinite(n) || n < 0) return { ok: false, output: "usage: shadows size <0-8192>" };
      s.size = n;
      s.enabled = n > 0;
    } else if (sub.length > 0) {
      return { ok: false, output: "usage: shadows [on|off|size <n>]" };
    }
    return { ok: true, output: `shadows ${s.enabled ? "on" : "off"} · ${s.size}px · distance ${s.distance} · strength ${s.strength}` };
  });

  reg.register("log", (args) => {
    const parts = args.trim().split(/\s+/);
    const level = (parts[0] as "log" | "info" | "warn" | "error") ?? "log";
    if (!["log", "info", "warn", "error"].includes(level)) {
      return { ok: false, output: "usage: log <log|info|warn|error> <message>" };
    }
    const msg = args.trim().slice(level.length).trim();
    if (msg.length === 0) return { ok: false, output: "usage: log <level> <message>" };
    engine.log.write(level, "console", msg);
    return { ok: true, output: `logged (${engine.log.size} buffered)` };
  });

  reg.register("errors", () => {
    const errs = engine.log.history({ level: "error", limit: 20 });
    if (errs.length === 0) return { ok: true, output: "no errors logged" };
    return { ok: true, output: errs.map((e) => `${e.system}: ${e.message}`).join("\n") };
  }, ["err"]);

  reg.register("fov", (args) => {
    const n = Number(args.trim());
    if (!Number.isFinite(n) || n <= 0 || n > 179) return { ok: false, output: "usage: fov <1-179> (degrees)" };
    engine.renderer.camera.fovY = (n * Math.PI) / 180;
    return { ok: true, output: `fov ${n}°` };
  });

  reg.register("pos", () => {
    const c = engine.renderer.camera;
    return { ok: true, output: `camera ${c.position.x.toFixed(2)}, ${c.position.y.toFixed(2)}, ${c.position.z.toFixed(2)} -> ${c.target.x.toFixed(2)}, ${c.target.y.toFixed(2)}, ${c.target.z.toFixed(2)}` };
  });

  return reg;
}

export type { CommandResult };
