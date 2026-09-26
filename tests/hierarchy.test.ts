import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import type { Transform } from "../src/ecs/components.js";
import {
  destroyTree, getChildren, getParent, isDescendantOf, setParent, worldPosition,
} from "../src/ecs/hierarchy.js";

function xform(x = 0, y = 0, z = 0, ry = 0, s = 1): Transform {
  return { position: new Vec3(x, y, z), rotationY: ry, scale: new Vec3(s, s, s) };
}

function node(w: World, t: Transform): number {
  const e = w.create();
  w.add(e, "transform", t);
  return e;
}

describe("hierarchy", () => {
  it("parents, children and detach", () => {
    const w = new World();
    const p = node(w, xform());
    const c = node(w, xform());
    expect(getParent(w, c)).toBeNull();
    setParent(w, c, p);
    expect(getParent(w, c)).toBe(p);
    expect(getChildren(w, p)).toEqual([c]);
    setParent(w, c, null);
    expect(getParent(w, c)).toBeNull();
    expect(getChildren(w, p)).toEqual([]);
  });

  it("composes translation down the chain", () => {
    const w = new World();
    const p = node(w, xform(10, 0, 0));
    const c = node(w, xform(1, 0, 0));
    setParent(w, c, p);
    const pos = worldPosition(w, c);
    expect(pos.x).toBeCloseTo(11);
    expect(pos.y).toBeCloseTo(0);
    expect(pos.z).toBeCloseTo(0);
  });

  it("rotates child offsets by parent yaw (90deg maps +x to -z)", () => {
    const w = new World();
    const p = node(w, xform(10, 0, 0, Math.PI / 2));
    const c = node(w, xform(1, 0, 0));
    setParent(w, c, p);
    const pos = worldPosition(w, c);
    expect(pos.x).toBeCloseTo(10);
    expect(pos.z).toBeCloseTo(-1);
  });

  it("scales child offsets by parent scale", () => {
    const w = new World();
    const p = node(w, xform(10, 0, 0, 0, 2));
    const c = node(w, xform(1, 0, 0));
    setParent(w, c, p);
    expect(worldPosition(w, c).x).toBeCloseTo(12);
  });

  it("rejects self-parenting, dead entities and cycles", () => {
    const w = new World();
    const a = node(w, xform());
    const b = node(w, xform());
    const dead = w.create();
    w.destroy(dead);
    expect(() => setParent(w, a, a)).toThrow();
    expect(() => setParent(w, a, dead)).toThrow();
    expect(() => setParent(w, dead, a)).toThrow();
    setParent(w, b, a);
    expect(() => setParent(w, a, b)).toThrow(); // would cycle
    expect(isDescendantOf(w, b, a)).toBe(true);
    expect(isDescendantOf(w, a, b)).toBe(false);
  });

  it("destroyTree cascades and clears dangling links", () => {
    const w = new World();
    const p = node(w, xform());
    const c = node(w, xform());
    const g = node(w, xform());
    setParent(w, c, p);
    setParent(w, g, c);
    destroyTree(w, p);
    expect(w.isAlive(p)).toBe(false);
    expect(w.isAlive(c)).toBe(false);
    expect(w.isAlive(g)).toBe(false);
    expect(w.count()).toBe(0);
  });
});
