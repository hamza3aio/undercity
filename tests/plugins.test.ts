import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { makeTransform } from "../src/ecs/components.js";
import {
  ExtensionRegistry, PLUGIN_MANIFEST_VERSION, PluginHost, SAMPLE_MANIFEST,
  parseManifest, resolveLoadOrder, validateManifest, type PluginManifest,
} from "../src/plugins/host.js";

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    name: "p",
    version: "1.0.0",
    dependsOn: [],
    provides: [],
    ...over,
  };
}

describe("manifest validation", () => {
  it("accepts a complete manifest", () => {
    const m = validateManifest({
      manifestVersion: 1, name: "x", version: "1.0.0",
      description: "d", dependsOn: ["y"], entry: "main.js",
      provides: [{ kind: "system", id: "s" }],
    });
    expect(m.name).toBe("x");
    expect(m.provides).toHaveLength(1);
  });

  it("fills optional fields and rejects bad ones with precise messages", () => {
    expect(validateManifest({ manifestVersion: 1, name: "x", version: "1" }).provides).toEqual([]);
    expect(() => validateManifest(null)).toThrow(/object/);
    expect(() => validateManifest({ manifestVersion: 2, name: "x", version: "1" })).toThrow(/manifestVersion/);
    expect(() => validateManifest({ manifestVersion: 1, version: "1" })).toThrow(/name/);
    expect(() => validateManifest({ manifestVersion: 1, name: "x" })).toThrow(/version/);
    expect(() => validateManifest({ manifestVersion: 1, name: "x", version: "1", dependsOn: [1] })).toThrow(/dependsOn/);
    expect(() => validateManifest({ manifestVersion: 1, name: "x", version: "1", provides: [{ kind: "zz", id: "a" }] })).toThrow(/kind/);
    expect(() => validateManifest({ manifestVersion: 1, name: "x", version: "1", provides: [{ kind: "tool" }] })).toThrow(/id/);
    expect(() => validateManifest({ manifestVersion: 1, name: "x", version: "1", entry: 5 })).toThrow(/entry/);
  });

  it("parses JSON and reports malformed input", () => {
    expect(parseManifest('{"manifestVersion":1,"name":"a","version":"1"}').name).toBe("a");
    expect(() => parseManifest("{oops")).toThrow(/malformed/);
  });
});

describe("load order", () => {
  it("puts dependencies first", () => {
    const order = resolveLoadOrder([
      manifest({ name: "c", dependsOn: ["b"] }),
      manifest({ name: "b", dependsOn: ["a"] }),
      manifest({ name: "a" }),
    ]);
    expect(order.map((m) => m.name)).toEqual(["a", "b", "c"]);
  });

  it("is stable for independent plugins", () => {
    const order = resolveLoadOrder([manifest({ name: "a" }), manifest({ name: "b" })]);
    expect(order.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("rejects duplicates, self-deps, missing deps and cycles", () => {
    expect(() => resolveLoadOrder([manifest({ name: "a" }), manifest({ name: "a" })])).toThrow(/duplicate/);
    expect(() => resolveLoadOrder([manifest({ name: "a", dependsOn: ["a"] })])).toThrow(/itself/);
    expect(() => resolveLoadOrder([manifest({ name: "a", dependsOn: ["ghost"] })])).toThrow(/missing plugin/);
    expect(() => resolveLoadOrder([
      manifest({ name: "a", dependsOn: ["b"] }),
      manifest({ name: "b", dependsOn: ["a"] }),
    ])).toThrow(/cycle/);
  });
});

describe("ExtensionRegistry", () => {
  it("registers, lists and removes by plugin", () => {
    const r = new ExtensionRegistry();
    r.add("component", "weather", "p", { a: 1 });
    r.add("tool", "rain", "p", () => undefined);
    expect(r.get("component", "weather")).toEqual({ a: 1 });
    expect(r.list("tool")).toHaveLength(1);
    expect(r.list()).toHaveLength(2);
    expect(r.size).toBe(2);
    expect(r.removePlugin("p")).toBe(2);
    expect(r.size).toBe(0);
  });

  it("rejects duplicates unless the policy says replace", () => {
    const r = new ExtensionRegistry();
    r.add("tool", "x", "a", 1);
    expect(() => r.add("tool", "x", "b", 2)).toThrow(/already provided by "a"/);
    r.setPolicy("replace");
    expect(() => r.add("tool", "x", "b", 2)).not.toThrow();
    expect(r.get("tool", "x")).toBe(2);
  });

  it("validates kind and id", () => {
    const r = new ExtensionRegistry();
    expect(() => r.add("nope" as never, "x", "p", 1)).toThrow();
    expect(() => r.add("tool", "", "p", 1)).toThrow();
  });
});

describe("PluginHost lifecycle", () => {
  const values = {
    "component:weather": { kind: "weather" },
    "system:weather-tick": { update: (dt: number) => { (globalThis as { weatherTicks?: number }).weatherTicks = ((globalThis as { weatherTicks?: number }).weatherTicks ?? 0) + dt; } },
    "tool:weather-now": { label: "Weather now", run: () => undefined },
  };

  it("loads a manifest and registers its extensions", () => {
    const h = new PluginHost();
    h.register(SAMPLE_MANIFEST);
    const loaded = h.loadAll(values);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].extensions).toBe(3);
    expect(h.registry.has("system", "weather-tick")).toBe(true);
    expect(h.panels()).toHaveLength(0);
    expect(h.tools()).toHaveLength(1);
  });

  it("runs plugin systems and isolates a throwing one", () => {
    (globalThis as { weatherTicks?: number }).weatherTicks = 0;
    const errors: string[] = [];
    const h = new PluginHost({ onError: (p) => errors.push(p) });
    h.register(manifest({ name: "boom", provides: [{ kind: "system", id: "bad" }] }));
    h.register(SAMPLE_MANIFEST);
    h.loadAll({ ...values, "system:bad": { update: () => { throw new Error("bad system"); } } });
    const world = new World();
    // The throwing system is reported and skipped, so only 1 update counts.
    expect(h.update(0.5, world)).toBe(1);
    expect((globalThis as { weatherTicks?: number }).weatherTicks).toBeCloseTo(0.5);
    expect(errors).toContain("system");
  });

  it("rolls back a plugin that fails mid-load", () => {
    const errors: unknown[] = [];
    const h = new PluginHost({ onError: (_p, e) => errors.push(e) });
    h.register(manifest({
      name: "half",
      provides: [{ kind: "tool", id: "ok" }, { kind: "system", id: "gone" }],
    }));
    h.loadAll({ "tool:ok": { label: "x", run: () => undefined } });
    expect(h.loaded).toHaveLength(0);
    expect(h.registry.size).toBe(0);
    expect(h.systemCount).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("reports a missing implementation", () => {
    const errors: string[] = [];
    const h = new PluginHost({ onError: (p) => errors.push(p) });
    h.register(manifest({ name: "p", provides: [{ kind: "tool", id: "nope" }] }));
    h.loadAll({});
    expect(errors).toEqual(["p"]);
    expect(h.loaded).toHaveLength(0);
  });

  it("unloads a plugin, its systems and its extensions", () => {
    let disposed = 0;
    const h = new PluginHost();
    h.register(manifest({ name: "p", provides: [{ kind: "system", id: "s" }] }));
    h.loadAll({ "system:s": { update: () => undefined, dispose: () => { disposed++; } } });
    expect(h.systemCount).toBe(1);
    expect(h.unload("p", new World())).toBe(1);
    expect(h.systemCount).toBe(0);
    expect(h.registry.size).toBe(0);
    expect(disposed).toBe(1);
  });

  it("unloading cascades to dependents", () => {
    const h = new PluginHost();
    h.register(manifest({ name: "base", provides: [{ kind: "tool", id: "b" }] }));
    h.register(manifest({ name: "dep", dependsOn: ["base"], provides: [{ kind: "tool", id: "d" }] }));
    h.loadAll({ "tool:b": { label: "b", run: () => undefined }, "tool:d": { label: "d", run: () => undefined } });
    expect(h.registry.size).toBe(2);
    h.unload("base");
    expect(h.loaded).toHaveLength(0);
    expect(h.registry.size).toBe(0);
  });

  it("routes an importer by file extension", () => {
    const h = new PluginHost();
    h.register(manifest({
      name: "imp",
      provides: [{ kind: "importer", id: "gltf" }, { kind: "editorPanel", id: "p1" }],
    }));
    h.loadAll({
      "importer:gltf": { extensions: [".gltf", ".glb"], label: "glTF", import: () => ({}) },
      "editorPanel:p1": { title: "Panel", mount: () => undefined },
    });
    expect(h.importerFor("model.GLB")?.label).toBe("glTF");
    expect(h.importerFor("notes.txt")).toBeNull();
    expect(h.panels()).toHaveLength(1);
  });

  it("loads in dependency order and is idempotent", () => {
    const order: string[] = [];
    const h = new PluginHost();
    h.register(manifest({ name: "b", dependsOn: ["a"], provides: [{ kind: "tool", id: "tb" }] }));
    h.register(manifest({ name: "a", provides: [{ kind: "tool", id: "ta" }] }));
    h.loadAll({ "tool:ta": { label: "a", run: () => order.push("a") }, "tool:tb": { label: "b", run: () => order.push("b") } });
    expect(h.loaded.map((p) => p.manifest.name)).toEqual(["a", "b"]);
    expect(() => h.loadAll({})).not.toThrow();
    expect(h.loaded).toHaveLength(2);
  });
});

describe("plugin + ECS integration", () => {
  it("a plugin system can drive real entities", () => {
    const h = new PluginHost();
    h.register(manifest({
      name: "spin",
      provides: [{ kind: "system", id: "spin-all" }],
    }));
    h.loadAll({
      "system:spin-all": {
        update: (_dt: number, world: World) => {
          for (const e of world.query("transform", "spin")) {
            const t = world.get<{ rotationY: number }>(e, "transform")!;
            t.rotationY += 0.1;
          }
        },
      },
    });
    const world = new World();
    const e = world.create();
    world.add(e, "transform", makeTransform());
    world.add(e, "spin", { speed: 1 });
    h.update(0.016, world);
    expect(world.get<{ rotationY: number }>(e, "transform")!.rotationY).toBeCloseTo(0.1);
  });
});
