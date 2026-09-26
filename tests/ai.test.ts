import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import type { Transform } from "../src/ecs/components.js";
import {
  bakeNavmesh, cellOf, findPath, isWalkableCell,
  setObstacle, smoothPath, type NavGrid,
} from "../src/ai/navmesh.js";
import { clearPath, hasArrived, separate, setPath, updateAgent } from "../src/ai/agent.js";

function staticBox(world: World, x: number, z: number, hx: number, hz: number) {
  const e = world.create();
  const t = makeTransform(x, 0, z);
  world.add(e, "transform", t);
  world.add(e, "collider", { halfExtents: new Vec3(hx, 0.5, hz), isStatic: true });
  return e;
}

function walker(world: World, x: number, z: number) {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, 0, z));
  return e;
}

function openGrid(): NavGrid {
  const world = new World();
  return bakeNavmesh(world, { minX: -10, maxX: 10, minZ: -10, maxZ: 10, cell: 1 });
}

describe("bakeNavmesh", () => {
  it("marks box footprints plus agent inflation", () => {
    const world = new World();
    staticBox(world, 0, 0, 2, 2);
    const g = bakeNavmesh(world, { minX: -10, maxX: 10, minZ: -10, maxZ: 10, cell: 1, agentRadius: 0.4 });
    expect(g.cols).toBe(20);
    expect(g.rows).toBe(20);
    // center cell blocked; inflation reaches past the 2.0 half-extent
    const c = cellOf(g, 0, 0);
    expect(isWalkableCell(g, c.i, c.j)).toBe(false);
    expect(isWalkableCell(g, 0, 0)).toBe(true); // far corner free
    // cell centers sit at half-integers: 1.5 is inside 2.0+0.4, 3.5 is outside
    expect(isWalkableCell(g, c.i + 1, c.j)).toBe(false);
    expect(isWalkableCell(g, c.i + 3, c.j)).toBe(true);
  });

  it("rejects bad bounds and cells", () => {
    const world = new World();
    expect(() => bakeNavmesh(world, { minX: 5, maxX: -5, minZ: 0, maxZ: 1, cell: 1 })).toThrow();
    expect(() => bakeNavmesh(world, { minX: 0, maxX: 1, minZ: 0, maxZ: 1, cell: 0 })).toThrow();
  });

  it("rejects steep terrain cells", () => {
    const world = new World();
    const te = world.create();
    world.add(te, "transform", makeTransform(0, 0, 0));
    // 5x5 cliff: columns 0-1 at 0, columns 2-4 at 6
    const heights: number[] = [];
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) heights.push(i < 2 ? 0 : 6);
    }
    world.add(te, "terrain", { size: 5, cell: 2, heights });
    const g = bakeNavmesh(world, { minX: -5, maxX: 5, minZ: -5, maxZ: 5, cell: 1, maxSlope: 0.6 });
    const west = cellOf(g, -4, 0);
    const cliff = cellOf(g, -1, 0);
    const top = cellOf(g, 4, 0);
    expect(isWalkableCell(g, west.i, west.j)).toBe(true); // flat lowland
    expect(isWalkableCell(g, cliff.i, cliff.j)).toBe(false); // the face itself
    expect(isWalkableCell(g, top.i, top.j)).toBe(true); // flat plateau
  });

  it("setObstacle blocks and clears discs", () => {
    const g = openGrid();
    const c = cellOf(g, 0, 0);
    expect(isWalkableCell(g, c.i, c.j)).toBe(true);
    setObstacle(g, 0, 0, 1.5, true);
    expect(isWalkableCell(g, c.i, c.j)).toBe(false);
    setObstacle(g, 0, 0, 1.5, false);
    expect(isWalkableCell(g, c.i, c.j)).toBe(true);
  });
});

describe("findPath", () => {
  it("routes around a wall", () => {
    const world = new World();
    // vertical wall at x=0 from z=-6..6 with a gap only at z in [8,10]... simpler: full wall, go around ends
    staticBox(world, 0, 0, 0.5, 6);
    const g = bakeNavmesh(world, { minX: -10, maxX: 10, minZ: -10, maxZ: 10, cell: 1, agentRadius: 0.2 });
    const path = findPath(g, -5, 0, 5, 0);
    expect(path).not.toBeNull();
    // every waypoint must be walkable
    for (const p of path!) {
      const c = cellOf(g, p.x, p.z);
      expect(isWalkableCell(g, c.i, c.j)).toBe(true);
    }
    // detour around a 12-tall wall from 10 apart must exceed the straight line
    let length = 0;
    for (let i = 1; i < path!.length; i++) {
      length += Math.hypot(path![i].x - path![i - 1].x, path![i].z - path![i - 1].z);
    }
    expect(length).toBeGreaterThan(13);
    // endpoints respected
    const last = path![path!.length - 1];
    expect(Math.hypot(last.x - 5, last.z - 0)).toBeLessThan(2);
  });

  it("returns null when boxed in", () => {
    const world = new World();
    // ring of boxes around origin
    staticBox(world, 0, -3, 4, 0.5);
    staticBox(world, 0, 3, 4, 0.5);
    staticBox(world, -3, 0, 0.5, 4);
    staticBox(world, 3, 0, 0.5, 4);
    const g = bakeNavmesh(world, { minX: -10, maxX: 10, minZ: -10, maxZ: 10, cell: 1, agentRadius: 0.2 });
    expect(findPath(g, 0, 0, 8, 8)).toBeNull();
  });

  it("clamps starts inside obstacles and smooths straight lines", () => {
    const g = openGrid();
    const straight = findPath(g, -8, 0, 8, 0)!;
    expect(straight.length).toBeLessThanOrEqual(2); // string-pulled to endpoints
    const world = new World();
    staticBox(world, 0, 0, 1, 1);
    const g2 = bakeNavmesh(world, { minX: -10, maxX: 10, minZ: -10, maxZ: 10, cell: 1, agentRadius: 0.2 });
    const fromInside = findPath(g2, 0, 0, 8, 0);
    expect(fromInside).not.toBeNull();
  });

  it("smoothPath keeps endpoints and stays walkable", () => {
    const g = openGrid();
    const pts = [{ x: -8, z: -8 }, { x: 0, z: -8 }, { x: 0, z: 8 }, { x: 8, z: 8 }];
    const s = smoothPath(g, pts);
    expect(s[0]).toEqual(pts[0]);
    expect(s[s.length - 1]).toEqual(pts[pts.length - 1]);
    expect(s.length).toBeLessThanOrEqual(pts.length);
  });
});

describe("agents", () => {
  it("walks waypoints, faces movement, and arrives", () => {
    const world = new World();
    const e = walker(world, 0, 0);
    setPath(world, e, [{ x: 4, z: 0 }, { x: 4, z: 3 }], 2);
    expect(hasArrived(world, e)).toBe(false);
    let status: string = "moving";
    for (let i = 0; i < 200 && status !== "arrived"; i++) {
      status = updateAgent(world, e, 0.05);
    }
    expect(status).toBe("arrived");
    expect(hasArrived(world, e)).toBe(true);
    const t = world.get<Transform>(e, "transform")!;
    expect(Math.hypot(t.position.x - 4, t.position.z - 3)).toBeLessThan(0.7);
  });

  it("idles without a path and errors on dead entities", () => {
    const world = new World();
    const e = walker(world, 0, 0);
    expect(updateAgent(world, e, 0.05)).toBe("idle");
    expect(hasArrived(world, e)).toBe(true);
    const dead = world.create();
    world.destroy(dead);
    expect(() => setPath(world, dead, [{ x: 1, z: 1 }], 1)).toThrow();
    clearPath(world, e); // no path: no-op, no throw
  });

  it("separates crowded agents", () => {
    const world = new World();
    const a = walker(world, 0, 0);
    const b = walker(world, 0.3, 0);
    setPath(world, a, [{ x: 0, z: 0 }], 1);
    setPath(world, b, [{ x: 0.3, z: 0 }], 1);
    const before = Math.hypot(
      world.get<Transform>(a, "transform")!.position.x - world.get<Transform>(b, "transform")!.position.x,
      world.get<Transform>(a, "transform")!.position.z - world.get<Transform>(b, "transform")!.position.z
    );
    separate(world, a, 2, 2, 0.5);
    separate(world, b, 2, 2, 0.5);
    const ta = world.get<Transform>(a, "transform")!;
    const tb = world.get<Transform>(b, "transform")!;
    const after = Math.hypot(ta.position.x - tb.position.x, ta.position.z - tb.position.z);
    expect(after).toBeGreaterThan(before);
  });
});
