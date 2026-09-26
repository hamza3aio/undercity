import { describe, expect, it } from "vitest";
import { Mat4 } from "../src/math/mat4.js";
import { Vec3 } from "../src/math/vec3.js";
import { cubeData, boundsRadius } from "../src/rendering/mesh.js";
import { frustumFromVP, testSphere } from "../src/rendering/frustum.js";
import { composeInstance, groupInstances, FLOATS_PER_INSTANCE, MIN_INSTANCES } from "../src/rendering/instancing.js";

function vpLookingDownMinusZ() {
  const view = Mat4.lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.up());
  const proj = Mat4.perspective(Math.PI / 3, 1, 0.1, 100);
  return proj.clone().multiply(view);
}

describe("boundsRadius", () => {
  it("equals the half-diagonal of a cube", () => {
    expect(boundsRadius(cubeData(2))).toBeCloseTo(Math.sqrt(3));
    expect(boundsRadius(cubeData(1))).toBeCloseTo(Math.sqrt(3) / 2);
  });
});

describe("frustum", () => {
  it("keeps what is in front and culls the rest", () => {
    const planes = frustumFromVP(vpLookingDownMinusZ());
    expect(planes).toHaveLength(6);
    expect(testSphere(planes, 0, 0, 0, 1)).toBe(true); // target
    expect(testSphere(planes, 0, 0, 4.9, 0.05)).toBe(true); // just inside near
    expect(testSphere(planes, 0, 0, 10, 1)).toBe(false); // behind camera
    expect(testSphere(planes, 0, 0, -200, 1)).toBe(false); // past far
    expect(testSphere(planes, 40, 0, 0, 1)).toBe(false); // far off-axis
    expect(testSphere(planes, 0, 0, 0, 1000)).toBe(true); // huge sphere always visible
  });

  it("normalizes plane equations", () => {
    const planes = frustumFromVP(vpLookingDownMinusZ());
    for (const p of planes) {
      expect(Math.hypot(p.a, p.b, p.c)).toBeCloseTo(1);
    }
  });
});

describe("composeInstance", () => {
  it("matches the renderer's Mat4 chain exactly", () => {
    const cases: [Vec3, number, Vec3][] = [
      [new Vec3(0, 0, 0), 0, new Vec3(1, 1, 1)],
      [new Vec3(5, -2, 7), 0.7, new Vec3(2, 3, 4)],
      [new Vec3(-3, 9, 1), Math.PI / 2, new Vec3(0.5, 0.5, 0.5)],
      [new Vec3(1, 1, 1), Math.PI, new Vec3(3, 1, 2)],
    ];
    for (const [pos, ry, sc] of cases) {
      const expected = new Mat4().translate(pos).rotateY(ry).scale(sc).elements;
      const out = new Float32Array(16);
      composeInstance(out, 0, pos.x, pos.y, pos.z, ry, sc.x, sc.y, sc.z);
      for (let i = 0; i < 16; i++) expect(out[i]).toBeCloseTo(expected[i]);
    }
  });

  it("writes at an offset with the documented stride", () => {
    const out = new Float32Array(FLOATS_PER_INSTANCE * 2);
    composeInstance(out, FLOATS_PER_INSTANCE, 5, 0, 0, 0, 1, 1, 1);
    expect(out[FLOATS_PER_INSTANCE + 12]).toBe(5);
    expect(out[12]).toBe(0); // first slot untouched
  });
});

describe("groupInstances", () => {
  it("groups by mesh+texture and preserves members", () => {
    const items = [
      { meshId: "cube" }, { meshId: "cube", textureId: "brick" },
      { meshId: "cube" }, { meshId: "ground" },
    ];
    const groups = groupInstances(items);
    expect(groups.size).toBe(3);
    expect(groups.get("cube\n")!).toHaveLength(2);
    expect(groups.get("cube\nbrick")!).toHaveLength(1);
  });

  it("threshold constant is sane", () => {
    expect(MIN_INSTANCES).toBeGreaterThanOrEqual(2);
  });
});
