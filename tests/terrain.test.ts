import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeRigidbody, makeTransform } from "../src/ecs/components.js";
import type { MeshRef, Transform } from "../src/ecs/components.js";
import { Physics } from "../src/physics/physics.js";
import {
  addNoise, createHeightmap, createSplat, extent, flatten, lower, mulberry32,
  paintSpot, paintWhere, raise, sampleHeight, scatterSpots, slopeAt, smooth,
  splatToCanvas, terrainMesh,
} from "../src/world/terrain.js";

describe("heightmap ops", () => {
  it("validates construction", () => {
    expect(() => createHeightmap(1, 1)).toThrow();
    expect(() => createHeightmap(4, 0)).toThrow();
    expect(createHeightmap(4, 2).heights).toHaveLength(16);
    expect(extent(createHeightmap(5, 2))).toBe(4);
  });

  it("raises a bump, lowers and flattens it", () => {
    const h = createHeightmap(9, 1);
    raise(h, 0, 0, 3, 4);
    expect(sampleHeight(h, 0, 0)).toBeGreaterThan(3);
    expect(sampleHeight(h, 0, 0)).toBeLessThanOrEqual(4);
    expect(sampleHeight(h, 3.5, 0)).toBe(0); // outside radius
    lower(h, 0, 0, 3, 2);
    const mid = sampleHeight(h, 0, 0);
    flatten(h, 0, 0, 3, 1);
    expect(sampleHeight(h, 0, 0)).toBeCloseTo(1, 2);
    expect(mid).toBeGreaterThan(1);
  });

  it("smooth reduces peaks", () => {
    const h = createHeightmap(9, 1);
    raise(h, 0, 0, 1.5, 8);
    const before = sampleHeight(h, 0, 0);
    smooth(h);
    expect(sampleHeight(h, 0, 0)).toBeLessThan(before);
  });

  it("noise is deterministic per seed", () => {
    const a = createHeightmap(9, 1);
    const b = createHeightmap(9, 1);
    addNoise(a, 42, 2, 6);
    addNoise(b, 42, 2, 6);
    expect(a.heights).toEqual(b.heights);
    addNoise(b, 43, 2, 6);
    expect(a.heights).not.toEqual(b.heights);
    expect(() => addNoise(a, 1, 1, 0)).toThrow();
  });

  it("mulberry32 is deterministic", () => {
    expect(mulberry32(7)()).toBe(mulberry32(7)());
  });
});

describe("sampling", () => {
  it("bilinear midpoints and clamped edges", () => {
    const h = createHeightmap(3, 2);
    // corners: set explicit heights
    h.heights = [0, 0, 0, 0, 4, 0, 0, 0, 0];
    // center vertex is 4; midpoint between center and corner blends
    expect(sampleHeight(h, 0, 0)).toBe(4);
    expect(sampleHeight(h, 1, 0)).toBe(2);
    expect(sampleHeight(h, 100, 100)).toBe(sampleHeight(h, 2, 2));
  });

  it("slope is zero on flats and positive on ramps", () => {
    const h = createHeightmap(5, 1);
    expect(slopeAt(h, 0, 0)).toBe(0);
    raise(h, 0, 0, 4, 4);
    expect(slopeAt(h, 2, 0)).toBeGreaterThan(0.1);
  });
});

describe("terrainMesh", () => {
  it("counts verts/tris and faces up", () => {
    const h = createHeightmap(5, 1);
    const full = terrainMesh(h, 4, 1);
    expect(full.positions.length).toBe(25 * 3);
    expect(full.indices.length).toBe(16 * 6);
    const lod = terrainMesh(h, 4, 2);
    expect(lod.positions.length).toBe(9 * 3);
    expect(lod.indices.length).toBe(4 * 6);
    // first triangle winds counter-clockwise seen from +Y
    const p = full.positions, idx = full.indices;
    const ax = p[idx[0] * 3], ay = p[idx[0] * 3 + 1], az = p[idx[0] * 3 + 2];
    const bx = p[idx[1] * 3], by = p[idx[1] * 3 + 1], bz = p[idx[1] * 3 + 2];
    const cx = p[idx[2] * 3], cy = p[idx[2] * 3 + 1], cz = p[idx[2] * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const ny = uz * vx - ux * vz; // y of u x v
    expect(ny).toBeGreaterThan(0);
    // flat normals point up
    expect(full.normals[1]).toBeCloseTo(1);
  });

  it("carries height into vertices", () => {
    const h = createHeightmap(5, 1);
    raise(h, 0, 0, 3, 5);
    const m = terrainMesh(h, 1, 1);
    let top = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i + 1]);
    expect(top).toBeGreaterThan(4);
  });
});

describe("scatterSpots", () => {
  it("stays in radius, respects slope, deterministic", () => {
    const h = createHeightmap(17, 2);
    raise(h, 0, 0, 20, 6); // big gentle hill
    const rnd = mulberry32(99);
    const a = scatterSpots(h, rnd, 0, 0, 10, 8, 10);
    expect(a).toHaveLength(8);
    for (const s of a) expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(10.001);
    const b = scatterSpots(h, mulberry32(99), 0, 0, 10, 8, 10);
    expect(a).toEqual(b);
    // impossible slope filter returns fewer (guard exits, no hang)
    const c = scatterSpots(h, mulberry32(1), 0, 0, 10, 8, -1);
    expect(c.length).toBeLessThanOrEqual(8);
  });
});

describe("splat painting", () => {
  it("paints exclusive channels in a disc", () => {
    const s = createSplat(16);
    paintSpot(s, 8, 0, 0, 4, 1);
    const k = (8 * 16 + 8) * 3; // disc center
    expect(s.data[k]).toBe(0);
    expect(s.data[k + 1]).toBe(255);
    expect(s.data[k + 2]).toBe(0);
    // far corner untouched (still channel 0)
    const f = (15 * 16 + 15) * 3;
    expect(s.data[f]).toBe(255);
    expect(s.data[f + 1]).toBe(0);
    paintSpot(s, 8, 0, 0, 1, 2);
    expect(s.data[k + 2]).toBe(255);
  });

  it("paintWhere fills from a predicate", () => {
    const s = createSplat(8);
    paintWhere(s, 4, 2, () => true);
    for (let i = 0; i < 64; i++) {
      expect(s.data[i * 3 + 2]).toBe(255);
      expect(s.data[i * 3]).toBe(0);
    }
  });

  it("ignores non-positive radii", () => {
    const s = createSplat(8);
    paintSpot(s, 4, 0, 0, 0, 1);
    expect(s.data[0]).toBe(255);
  });
});

describe("terrain physics", () => {
  function hillWorld() {
    const world = new World();
    const phys = new Physics();
    const h = createHeightmap(9, 2);
    raise(h, 0, 0, 12, 4); // broad hill, peak ~4 at center
    const te = world.create();
    world.add(te, "transform", makeTransform(0, 0, 0));
    world.add(te, "terrain", { size: 9, cell: 2, heights: [...h.heights] });
    return { world, phys, top: sampleHeight(h, 0, 0) };
  }

  it("rests boxes on the hilltop", () => {
    const { world, phys, top } = hillWorld();
    const e = world.create();
    world.add(e, "transform", makeTransform(0, 8, 0));
    world.add(e, "rigidbody", makeRigidbody(true, 1));
    world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    for (let i = 0; i < 240; i++) phys.step(world, 1 / 60);
    const t = world.get<Transform>(e, "transform")!;
    expect(t.position.y).toBeCloseTo(top + 0.5, 0);
    expect(world.get<{ grounded: boolean }>(e, "rigidbody")!.grounded).toBe(true);
  });

  it("ignores bodies outside the patch", () => {
    const { world, phys } = hillWorld();
    const e = world.create();
    world.add(e, "transform", makeTransform(50, 5, 0));
    world.add(e, "rigidbody", makeRigidbody(true, 1));
    world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    for (let i = 0; i < 180; i++) phys.step(world, 1 / 60);
    expect(world.get<Transform>(e, "transform")!.position.y).toBeCloseTo(0.5, 1);
  });

  it("supports spheres and serializes as plain JSON", () => {
    const { world, phys, top } = hillWorld();
    const e = world.create();
    world.add(e, "transform", makeTransform(0, 8, 0));
    world.add(e, "rigidbody", makeRigidbody(true, 1));
    world.add(e, "sphere", { radius: 1, isStatic: false });
    for (let i = 0; i < 240; i++) phys.step(world, 1 / 60);
    expect(world.get<Transform>(e, "transform")!.position.y).toBeCloseTo(top + 1, 0);
    const json = JSON.stringify(world.get(e, "terrain") ?? world.get(
      world.query("transform", "terrain")[0], "terrain"
    ));
    expect(json).toContain("heights");
  });
});

describe("splat canvas", () => {
  it("encodes weights as RGB pixels (headless canvas stub)", () => {
    let captured: Uint8ClampedArray | null = null;
    (globalThis as Record<string, unknown>).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4);
            captured = data;
            return { width: w, height: h, data };
          },
          putImageData: (img: { data: Uint8ClampedArray }) => { captured = img.data; },
        }),
      }),
    };
    try {
      const s = createSplat(4);
      paintSpot(s, 2, 0, 0, 2, 1);
      splatToCanvas(s);
      expect(captured).not.toBeNull();
      let seenGreen = false;
      for (let i = 0; i < captured!.length; i += 4) {
        if (captured![i + 1] === 255) seenGreen = true;
        expect(captured![i + 3]).toBe(255);
      }
      expect(seenGreen).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).document;
    }
  });
});
