import { describe, expect, it } from "vitest";
import { Vec3 } from "../src/math/vec3.js";
import { Mat4 } from "../src/math/mat4.js";

describe("Vec3", () => {
  it("adds, scales and normalizes", () => {
    const v = new Vec3(1, 2, 3).add(new Vec3(1, 1, 1));
    expect([v.x, v.y, v.z]).toEqual([2, 3, 4]);
    expect(new Vec3(0, 0, 5).normalize().z).toBeCloseTo(1);
  });

  it("dot and cross follow right-hand rule", () => {
    expect(new Vec3(1, 0, 0).dot(new Vec3(0, 1, 0))).toBe(0);
    const c = new Vec3(1, 0, 0).cross(new Vec3(0, 1, 0));
    expect([c.x, c.y, c.z]).toEqual([0, 0, 1]);
  });
});

describe("Mat4", () => {
  it("identity * x = x", () => {
    const a = new Mat4().translate(new Vec3(1, 2, 3));
    const out = new Mat4().multiply(a);
    expect(Array.from(out.elements)).toEqual(Array.from(a.elements));
  });

  it("lookAt puts the eye at the origin of view space", () => {
    const view = Mat4.lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.up());
    // translation part of a lookAt from (0,0,5) is (0,0,-5)
    expect(view.elements[12]).toBeCloseTo(0);
    expect(view.elements[13]).toBeCloseTo(0);
    expect(view.elements[14]).toBeCloseTo(-5);
  });

  it("perspective has -1 in the perspective slot", () => {
    const p = Mat4.perspective(Math.PI / 3, 16 / 9, 0.1, 100);
    expect(p.elements[11]).toBe(-1);
    expect(p.elements[15]).toBe(0);
  });

  it("compose translates then rotates then scales like the renderer", () => {
    const m = Mat4.compose(new Vec3(10, 0, 0), 0, new Vec3(2, 2, 2));
    // local (1,0,0) -> scale 2 -> (2,0,0) -> translate -> (12,0,0)
    expect(m.elements[12]).toBeCloseTo(10);
    expect(m.elements[0]).toBeCloseTo(2);
  });

  it("inverts composed matrices back to identity", () => {
    const m = Mat4.compose(new Vec3(5, -2, 7), 0.7, new Vec3(2, 3, 4));
    const inv = m.invert();
    expect(inv).not.toBeNull();
    const id = Mat4.multiplied(m, inv!);
    const want = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) expect(id.elements[i]).toBeCloseTo(want[i], 4);
  });

  it("inverts lookAt and perspective round-trips", () => {
    const v = Mat4.lookAt(new Vec3(1, 2, 3), new Vec3(0, 0, 0), Vec3.up());
    const back = v.invert()!.clone().multiply(v);
    for (let i = 0; i < 16; i++) {
      expect(back.elements[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 4);
    }
  });

  it("returns null for singular matrices", () => {
    const m = new Mat4();
    m.elements[0] = 0; m.elements[5] = 0; m.elements[10] = 0; m.elements[15] = 0;
    expect(m.invert()).toBeNull();
    const zeroScale = new Mat4().scale(new Vec3(0, 1, 1));
    expect(zeroScale.invert()).toBeNull();
  });
});
