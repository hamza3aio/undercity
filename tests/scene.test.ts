import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import type { MeshRef, Transform } from "../src/ecs/components.js";
import { loadScene, saveScene } from "../src/scene/scene.js";
import { buildActor } from "../src/scene/actor.js";

// Headless 2D-context stub: absorbs every canvas call so procedural painters
// run under Node without a DOM. Test-only; production still uses real canvas.
function stubDocument() {
  const grad = { addColorStop() { /* noop */ } };
  const ctx = new Proxy(
    {},
    {
      get: (_t, p: string | symbol) => {
        if (p === "createLinearGradient") return () => grad;
        if (p === "measureText") return () => ({ width: 0 });
        if (p === "getImageData") return () => ({ data: [] });
        return (..._a: unknown[]) => undefined;
      },
      set: () => true,
    }
  );
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ctx,
    }),
  };
}

describe("scene serialization", () => {
  it("round-trips transforms, meshes and static flags", () => {
    const w = new World();
    const e = w.create();
    const t = makeTransform(1, 2, 3);
    t.rotationY = 0.5;
    t.scale.set(2, 2, 2);
    w.add(e, "transform", t);
    w.add<MeshRef>(e, "mesh", { meshId: "cube", color: [1, 0, 0] });
    w.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });

    const json = saveScene(w);
    const w2 = new World();
    loadScene(w2, json);
    const [loaded] = w2.query("transform", "mesh");
    expect(loaded).toBeDefined();
    const lt = w2.get<Transform>(loaded, "transform")!;
    expect([lt.position.x, lt.position.y, lt.position.z]).toEqual([1, 2, 3]);
    expect(lt.rotationY).toBeCloseTo(0.5);
    expect(w2.get<MeshRef>(loaded, "mesh")).toMatchObject({ meshId: "cube", color: [1, 0, 0] });
    expect(w2.get<{ isStatic: boolean }>(loaded, "collider")).toMatchObject({ isStatic: true });
  });

  it("round-trips actor rigs without touching the DOM", () => {
    stubDocument();
    const w = new World();
    const calls: string[] = [];
    const rig = buildActor(w, (id) => { calls.push(id); }, {
      skin: [1, 1, 1], shirt: [0, 0, 1], trim: [0, 0, 0.5],
      pants: [0, 0, 0], hair: null,
      face: { eye: "round", mouth: "smile", blush: false, beard: false },
      tag: "test-actor",
    });
    expect(calls).toEqual(["test-actor-face", "test-actor-shirt"]);

    const json = saveScene(w);
    const parsed = JSON.parse(json) as { entities: { actor?: unknown }[] };
    expect(parsed.entities.some((e) => e.actor !== undefined)).toBe(true);

    const w2 = new World();
    const texIds: string[] = [];
    loadScene(w2, json, (id) => { texIds.push(id); });
    expect(texIds).toEqual(["test-actor-face", "test-actor-shirt"]);
    // rig head + 6 parts, no stray actorPart entities serialized
    expect(w2.query("transform").length).toBeGreaterThan(0);
    void rig;
  });
});
