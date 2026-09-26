import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import type { MeshRef, Transform } from "../src/ecs/components.js";
import { setParent } from "../src/ecs/hierarchy.js";
import { assignUid, findByUid, getUid } from "../src/ecs/ids.js";
import { loadScene } from "../src/scene/scene.js";
import { instantiatePrefab, parsePrefab, savePrefab } from "../src/scene/prefabs.js";

function box(w: World, x: number, y: number, z: number, uid?: string) {
  const e = w.create();
  w.add(e, "transform", makeTransform(x, y, z));
  w.add<MeshRef>(e, "mesh", { meshId: "cube", color: [1, 1, 1] });
  if (uid) assignUid(w, e, uid);
  return e;
}

describe("stable IDs", () => {
  it("assigns, reads and finds UIDs, rejects collisions", () => {
    const w = new World();
    const a = box(w, 0, 0, 0);
    const b = box(w, 1, 1, 1);
    expect(getUid(w, a)).toBeNull();
    const auto = assignUid(w, a);
    expect(typeof auto).toBe("string");
    expect(getUid(w, a)).toBe(auto);
    expect(findByUid(w, auto)).toBe(a);
    assignUid(w, b, "hero");
    expect(findByUid(w, "hero")).toBe(b);
    expect(() => assignUid(w, a, "hero")).toThrow(); // taken
    expect(assignUid(w, b, "hero")).toBe("hero"); // idempotent
    expect(findByUid(w, "nope")).toBeNull();
    const dead = w.create();
    expect(() => assignUid(w, dead, "x")).not.toThrow();
    w.destroy(dead);
    expect(() => assignUid(w, dead, "y")).toThrow();
  });
});

describe("prefabs", () => {
  it("saves a parented subtree and instantiates it with structure intact", () => {
    const w = new World();
    const root = box(w, 10, 0, 0, "base");
    const child = box(w, 11, 0, 0);
    setParent(w, child, root);
    // custom collider extents must survive (regression: v1/v2 were lossy)
    w.add(root, "collider", { halfExtents: new Vec3(2, 1, 3), isStatic: true });

    const json = savePrefab(w, root, "Hut", "hut-1");
    const def = parsePrefab(json);
    expect(def.guid).toBe("hut-1");
    expect(def.entities).toHaveLength(2);

    const w2 = new World();
    const inst = instantiatePrefab(w2, def);
    expect(w2.isAlive(inst.root)).toBe(true);
    expect(inst.byUid.get("base")).toBe(inst.root);
    const kids = w2.query("parent").filter((e) => e !== inst.root);
    expect(kids).toHaveLength(1);
    const pos = w2.get<Transform>(kids[0], "transform")!.position;
    expect([pos.x, pos.y, pos.z]).toEqual([11, 0, 0]);
    const col = w2.get<{ halfExtents: Vec3; isStatic: boolean }>(inst.root, "collider")!;
    expect([col.halfExtents.x, col.halfExtents.y, col.halfExtents.z]).toEqual([2, 1, 3]);
  });

  it("instantiates twice with unique UIDs and independent entities", () => {
    const w = new World();
    const root = box(w, 0, 0, 0, "solo");
    const def = parsePrefab(savePrefab(w, root, "Solo", "solo-1"));
    const w2 = new World();
    const a = instantiatePrefab(w2, def);
    const b = instantiatePrefab(w2, def);
    expect(a.root).not.toBe(b.root);
    expect(getUid(w2, a.root)).toBe("solo");
    expect(getUid(w2, b.root)).not.toBe("solo");
    expect(getUid(w2, b.root)).toContain("solo-1");
  });

  it("rejects malformed prefab JSON with clear errors", () => {
    expect(() => parsePrefab("nope")).toThrow(/malformed/);
    expect(() => parsePrefab("{}")).toThrow(/guid/);
    expect(() => parsePrefab(JSON.stringify({ guid: "g" }))).toThrow(/name/);
  });
});

describe("scene migration", () => {
  it("loads legacy v1 scenes (no version, boolean static)", () => {
    const w = new World();
    const legacy = JSON.stringify({
      entities: [{
        pos: [1, 2, 3], rotY: 0, scale: [1, 1, 1],
        mesh: { meshId: "cube", color: [1, 0, 0] }, static: true,
      }],
    });
    const stats = loadScene(w, legacy);
    expect(stats.migratedFrom).toBe(1);
    expect(stats.loaded).toBe(1);
    const [e] = w.query("transform");
    const col = w.get<{ halfExtents: Vec3; isStatic: boolean }>(e, "collider")!;
    expect(col.isStatic).toBe(true);
    expect([col.halfExtents.x, col.halfExtents.y, col.halfExtents.z]).toEqual([0.5, 0.5, 0.5]);
  });

  it("links v3 parentUid chains", () => {
    const w = new World();
    const stats = loadScene(w, JSON.stringify({
      version: 3,
      entities: [
        { uid: "p", pos: [5, 0, 0], rotY: 0, scale: [1, 1, 1] },
        { uid: "c", parentUid: "p", pos: [6, 0, 0], rotY: 0, scale: [1, 1, 1] },
      ],
    }));
    expect(stats.migratedFrom).toBe(3);
    const child = findByUid(w, "c")!;
    expect(w.get<{ parent: number }>(child, "parent")?.parent).toBe(findByUid(w, "p"));
  });

  it("rejects malformed scene JSON with clear errors", () => {
    const w = new World();
    expect(() => loadScene(w, "nope")).toThrow(/malformed/);
    expect(() => loadScene(w, "{}")).toThrow(/entities/);
  });
});
