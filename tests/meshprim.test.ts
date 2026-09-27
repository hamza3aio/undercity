import { describe, expect, it } from "vitest";
import { boundsRadius, cubeData, planeData, pyramidData, sphereData } from "../src/rendering/mesh.js";

/** Every normal must be a unit vector and every index in range. */
function checkMesh(m: { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint16Array }): void {
  const verts = m.positions.length / 3;
  expect(m.normals.length).toBe(verts * 3);
  expect(m.uvs.length).toBe(verts * 2);
  expect(m.indices.length % 3).toBe(0);
  for (let i = 0; i < verts; i++) {
    const n = Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
    expect(n).toBeCloseTo(1, 5);
  }
  for (const idx of m.indices) expect(idx).toBeLessThan(verts);
}

describe("pyramidData", () => {
  it("builds a closed solid with valid data", () => {
    const m = pyramidData(2, 3);
    checkMesh(m);
    // 4 side triangles + 2 bottom triangles.
    expect(m.indices.length).toBe(18);
  });

  it("scales to the requested base and height", () => {
    const m = pyramidData(4, 6);
    const xs = [];
    const ys = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      xs.push(m.positions[i]);
      ys.push(m.positions[i + 1]);
    }
    expect(Math.max(...xs)).toBeCloseTo(2);
    expect(Math.min(...xs)).toBeCloseTo(-2);
    expect(Math.max(...ys)).toBeCloseTo(6);
    expect(Math.min(...ys)).toBeCloseTo(0);
  });

  it("has side normals pointing outward", () => {
    const m = pyramidData(2, 2);
    // The +Z face (corners at z = +1) must have a normal with z > 0.
    let outward = 0;
    for (let i = 0; i < m.normals.length; i += 3) {
      if (m.normals[i + 2] > 0.1) outward++;
    }
    expect(outward).toBeGreaterThan(0);
  });

  it("has a radius that covers the apex", () => {
    expect(boundsRadius(pyramidData(2, 6))).toBeCloseTo(6, 5);
  });
});

describe("sphereData", () => {
  it("builds valid data for a coarse sphere", () => {
    const m = sphereData(1, 4, 6);
    checkMesh(m);
    expect(m.indices.length).toBe(4 * 6 * 6);
  });

  it("puts every vertex on the sphere", () => {
    const m = sphereData(2, 3, 5);
    for (let i = 0; i < m.positions.length; i += 3) {
      const d = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
      expect(d).toBeCloseTo(2, 4);
    }
    expect(boundsRadius(m)).toBeCloseTo(2, 4);
  });

  it("clamps degenerate parameters instead of producing NaNs", () => {
    const m = sphereData(1, 0, 1);
    checkMesh(m);
    for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
    for (const v of m.normals) expect(Number.isFinite(v)).toBe(true);
    // Rings clamp to 1, segments clamp to 3 -> one row of quads.
    expect(m.indices.length).toBe(1 * 3 * 6);
  });

  it("emits a pole vertex at the top and bottom", () => {
    const m = sphereData(1, 4, 6);
    expect(m.positions[1]).toBeCloseTo(1);
    expect(m.positions[m.positions.length - 2]).toBeCloseTo(-1);
  });

  it("covers the whole uv range", () => {
    const m = sphereData(1, 4, 6);
    const us = [];
    const vs = [];
    for (let i = 0; i < m.uvs.length; i += 2) {
      us.push(m.uvs[i]);
      vs.push(m.uvs[i + 1]);
    }
    expect(Math.min(...us)).toBeCloseTo(0);
    expect(Math.max(...us)).toBeCloseTo(1);
    expect(Math.min(...vs)).toBeCloseTo(0);
    expect(Math.max(...vs)).toBeCloseTo(1);
  });
});

describe("existing primitives still validate", () => {
  it("cube and plane", () => {
    checkMesh(cubeData());
    checkMesh(planeData());
    expect(cubeData().indices.length).toBe(36);
  });
});
