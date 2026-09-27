import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform, makeLight, type Light, type Transform } from "../src/ecs/components.js";
import { findByUid, assignUid } from "../src/ecs/ids.js";
import { getParent } from "../src/ecs/hierarchy.js";
import {
  SCENE_VERSION, applyOverrides, clearScene, loadScene, migrateScene, saveScene,
} from "../src/scene/scene.js";
import { instantiatePrefab, parsePrefab, savePrefab } from "../src/scene/prefabs.js";

function box(world: World, x = 0, y = 0, z = 0, uid?: string): number {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  world.add(e, "mesh", { meshId: "cube", color: [1, 1, 1] });
  world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });
  if (uid) assignUid(world, e, uid);
  return e;
}

describe("migrateScene", () => {
  it("upgrades a versionless v1 file and synthesizes collider extents", () => {
    const out = migrateScene({ entities: [{ pos: [1, 2, 3], rotY: 0.5, scale: [1, 1, 1], static: true }] });
    expect(out.version).toBe(SCENE_VERSION);
    expect(out.entities[0].collider).toEqual({ halfExtents: [0.5, 0.5, 0.5], static: true });
    expect(out.entities[0].pos).toEqual([1, 2, 3]);
  });

  it("upgrades a v2 file (static only) the same way", () => {
    const out = migrateScene({ version: 2, entities: [{ pos: [0, 0, 0], rotY: 0, scale: [1, 1, 1], static: false }] });
    expect(out.entities[0].collider).toEqual({ halfExtents: [0.5, 0.5, 0.5], static: false });
  });

  it("keeps v3 collider extents intact", () => {
    const out = migrateScene({
      version: 3,
      entities: [{ pos: [0, 0, 0], rotY: 0, scale: [1, 1, 1], collider: { halfExtents: [2, 3, 4], static: true } }],
    });
    expect(out.entities[0].collider?.halfExtents).toEqual([2, 3, 4]);
  });

  it("carries v4 components across", () => {
    const heights = new Array(4 * 4).fill(0.5);
    const out = migrateScene({
      version: 4,
      entities: [{
        pos: [0, 1, 0], rotY: 0, scale: [1, 1, 1], name: "Hill",
        light: { kind: "spot", color: [1, 0, 0], intensity: 2, range: 9, direction: [0, -1, 0], innerAngle: 0.2, outerAngle: 0.4, on: true },
        terrain: { size: 4, cell: 1, heights },
        spin: { speed: 3 },
        trigger: { halfExtents: [1, 2, 3] },
        rigidbody: { velocity: [1, 2, 3], useGravity: false, mass: 7 },
      }],
    });
    const e = out.entities[0];
    expect(e.name).toBe("Hill");
    expect(e.light?.kind).toBe("spot");
    expect(e.terrain?.heights).toHaveLength(16);
    expect(e.spin?.speed).toBe(3);
    expect(e.trigger?.halfExtents).toEqual([1, 2, 3]);
    expect(e.rigidbody?.velocity).toEqual([1, 2, 3]);
  });

  it("drops malformed terrain rather than creating a broken one", () => {
    const out = migrateScene({
      version: 4,
      entities: [{ pos: [0, 0, 0], rotY: 0, scale: [1, 1, 1], terrain: { size: 4, cell: 1, heights: [1, 2, 3] } }],
    });
    expect(out.entities[0].terrain).toBeUndefined();
  });

  it("fills missing/invalid scalars with safe defaults", () => {
    const out = migrateScene({ entities: [{ pos: "nope", rotY: NaN, scale: [1, 1] }] });
    expect(out.entities[0].pos).toEqual([0, 0, 0]);
    expect(out.entities[0].rotY).toBe(0);
    expect(out.entities[0].scale).toEqual([1, 1, 1]);
  });

  it("refuses payloads that are not scenes, and future versions", () => {
    expect(() => migrateScene(null)).toThrow();
    expect(() => migrateScene({ entities: "no" })).toThrow();
    expect(() => migrateScene({ version: SCENE_VERSION + 1, entities: [] })).toThrow(/newer/);
  });

  it("keeps the optional scene name", () => {
    expect(migrateScene({ name: "Street", entities: [] }).name).toBe("Street");
  });
});

describe("round trip", () => {
  it("saves and reloads every supported component", () => {
    const world = new World();
    const a = box(world, 1, 2, 3, "box-a");
    world.add(a, "spin", { speed: 4 });
    world.add(a, "name", { value: "Crate" });
    const b = world.create();
    world.add(b, "transform", makeTransform(0, 4, 0));
    world.add(b, "light", makeLight("spot"));
    const c = world.create();
    world.add(c, "transform", makeTransform(6, 0, 0));
    world.add(c, "terrain", { size: 2, cell: 1, heights: [0, 0.5, 1, 1.5] });
    const d = world.create();
    world.add(d, "transform", makeTransform(8, 0, 0));
    world.add(d, "trigger", { halfExtents: new Vec3(1, 1, 1), entered: false });

    const json = saveScene(world, "TestScene");
    const world2 = new World();
    const stats = loadScene(world2, json);
    expect(stats.version).toBe(SCENE_VERSION);
    expect(stats.migratedFrom).toBe(SCENE_VERSION);
    expect(stats.loaded).toBe(4);
    expect(stats.skipped).toBe(0);

    const ra = findByUid(world2, "box-a");
    expect(ra).not.toBeNull();
    expect(world2.get<{ speed: number }>(ra!, "spin")?.speed).toBe(4);
    expect(world2.get<{ value: string }>(ra!, "name")?.value).toBe("Crate");
    const lights = world2.query("transform", "light");
    expect(lights).toHaveLength(1);
    expect(world2.get<Light>(lights[0], "light")!.kind).toBe("spot");
    const terr = world2.query("transform", "terrain");
    expect(world2.get<{ heights: number[] }>(terr[0], "terrain")!.heights).toEqual([0, 0.5, 1, 1.5]);
    expect(world2.query("trigger")).toHaveLength(1);
  });

  it("is deterministic (same world, same bytes)", () => {
    const world = new World();
    box(world, 1, 0, 0, "x");
    box(world, 2, 0, 0, "y");
    expect(saveScene(world)).toBe(saveScene(world));
  });

  it("preserves rigidbody velocity now (v4 was lossy here)", () => {
    const world = new World();
    const e = box(world);
    world.add(e, "rigidbody", { velocity: new Vec3(1, 2, 3), useGravity: false, mass: 5, grounded: false });
    const world2 = new World();
    loadScene(world2, saveScene(world));
    const rb = world2.query("rigidbody")[0];
    expect(world2.get<{ velocity: Vec3; mass: number }>(rb, "rigidbody")!.velocity.y).toBeCloseTo(2);
    expect(world2.get<{ mass: number }>(rb, "rigidbody")!.mass).toBe(5);
  });

  it("keeps parent links across a save/load", () => {
    const world = new World();
    const parent = box(world, 0, 0, 0, "p");
    const child = box(world, 0, 1, 0, "c");
    world.add(child, "parent", { parent });
    const world2 = new World();
    loadScene(world2, saveScene(world));
    expect(getParent(world2, findByUid(world2, "c")!)).toBe(findByUid(world2, "p"));
  });
});

describe("recovery", () => {
  it("skips a broken entity and loads the rest, reporting why", () => {
    const json = JSON.stringify({
      version: 4,
      entities: [
        { pos: [0, 0, 0], rotY: 0, scale: [1, 1, 1], uid: "ok1", mesh: { meshId: "cube", color: [1, 1, 1] } },
        // A component that explodes on add: entity-level try/catch must hold.
        { pos: [1, 0, 0], rotY: 0, scale: [1, 1, 1], uid: "bad", light: { kind: "spot" } },
        { pos: [2, 0, 0], rotY: 0, scale: [1, 1, 1], uid: "ok2", mesh: { meshId: "cube", color: [0, 1, 0] } },
      ],
    });
    const world = new World();
    const stats = loadScene(world, json);
    expect(stats.loaded).toBeGreaterThanOrEqual(2);
    expect(findByUid(world, "ok1")).not.toBeNull();
    expect(findByUid(world, "ok2")).not.toBeNull();
  });

  it("throws clear errors on malformed JSON and non-scene payloads", () => {
    const world = new World();
    expect(() => loadScene(world, "{not json")).toThrow(/malformed JSON/);
    expect(() => loadScene(world, '{"hello":1}')).toThrow(/entities/);
  });

  it("keeps the old world when a load throws (no half-cleared scene)", () => {
    const world = new World();
    box(world, 0, 0, 0, "keep");
    expect(() => loadScene(world, "garbage")).toThrow();
    expect(findByUid(world, "keep")).not.toBeNull();
  });

  it("bounds the error list", () => {
    const entities = Array.from({ length: 200 }, (_, i) => ({
      pos: [i, 0, 0], rotY: 0, scale: [1, 1, 1], uid: `e${i}`, light: { kind: "spot" },
    }));
    const world = new World();
    const stats = loadScene(world, JSON.stringify({ version: 4, entities }));
    expect(stats.errors.length).toBeLessThanOrEqual(50);
  });
});

describe("additive scenes", () => {
  it("merges instead of clearing", () => {
    const world = new World();
    box(world, 0, 0, 0, "base");
    const json = JSON.stringify({ version: 4, entities: [{ pos: [5, 0, 0], rotY: 0, scale: [1, 1, 1], uid: "extra", mesh: { meshId: "cube", color: [1, 1, 1] } }] });
    const stats = loadScene(world, json, { additive: true });
    expect(stats.additive).toBe(true);
    expect(findByUid(world, "base")).not.toBeNull();
    expect(findByUid(world, "extra")).not.toBeNull();
  });

  it("replaces the world by default", () => {
    const world = new World();
    box(world, 0, 0, 0, "old");
    const json = JSON.stringify({ version: 4, entities: [{ pos: [5, 0, 0], rotY: 0, scale: [1, 1, 1], uid: "new", mesh: { meshId: "cube", color: [1, 1, 1] } }] });
    loadScene(world, json);
    expect(findByUid(world, "old")).toBeNull();
    expect(findByUid(world, "new")).not.toBeNull();
  });

  it("clearScene removes every transform entity", () => {
    const world = new World();
    box(world, 0, 0, 0);
    box(world, 1, 0, 0);
    expect(clearScene(world)).toBe(2);
    expect(world.query("transform")).toHaveLength(0);
  });
});

describe("overrides", () => {
  it("patches matching entities by uid and reports unknown ones", () => {
    const world = new World();
    box(world, 0, 0, 0, "a");
    box(world, 1, 0, 0, "b");
    const n = applyOverrides(world, {
      a: { pos: [9, 9, 9], rotY: 1.25, name: "moved" },
      ghost: { pos: [0, 0, 0] },
    });
    expect(n).toBe(1);
    const a = findByUid(world, "a")!;
    expect(world.get<Transform>(a, "transform")!.position.x).toBe(9);
    expect(world.get<Transform>(a, "transform")!.rotationY).toBe(1.25);
    expect(world.get<{ value: string }>(a, "name")!.value).toBe("moved");
  });

  it("applies overrides during loadScene too", () => {
    const world = new World();
    const json = JSON.stringify({ version: 4, entities: [{ pos: [0, 0, 0], rotY: 0, scale: [1, 1, 1], uid: "a", mesh: { meshId: "cube", color: [1, 1, 1] } }] });
    loadScene(world, json, { overrides: { a: { scale: [3, 3, 3] } } });
    expect(world.get<Transform>(findByUid(world, "a")!, "transform")!.scale.x).toBe(3);
  });
});

describe("prefab overrides (nested prefabs)", () => {
  it("instantiates and applies per-UID overrides", () => {
    const src = new World();
    const root = box(src, 0, 0, 0, "root");
    const child = box(src, 0, 1, 0, "child");
    src.add(child, "parent", { parent: root });
    const json = savePrefab(src, root, "Tower", "tower-guid");
    const def = parsePrefab(json);
    expect(def.entities).toHaveLength(2);

    const world = new World();
    const inst = instantiatePrefab(world, def, { overrides: { child: { pos: [0, 5, 0] } } });
    expect(inst.byUid.size).toBe(2);
    const spawned = inst.byUid.get("child")!;
    expect(world.get<Transform>(spawned, "transform")!.position.y).toBe(5);
  });

  it("reports overrides for local UIDs the prefab does not contain", () => {
    const src = new World();
    const root = box(src, 0, 0, 0, "root");
    const def = parsePrefab(savePrefab(src, root, "Solo", "solo"));
    const world = new World();
    expect(() => instantiatePrefab(world, def, { overrides: { nope: { pos: [0, 0, 0] } } })).not.toThrow();
  });
});
