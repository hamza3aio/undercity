// Glitch frustum — perspective frustum planes + sphere test.
// Planes extracted from a column-major view-projection matrix
// (clip = P * V * pos). Spheres are rotation-proof, which matches our
// yaw-only, physics-ignores-rotation world.

import type { Mat4 } from "../math/mat4.js";

export interface Plane {
  a: number;
  b: number;
  c: number;
  d: number;
}

export function frustumFromVP(m: Mat4): Plane[] {
  const e = m.elements;
  // rows of a column-major 4x4
  const row = (i: number): [number, number, number, number] => [e[i], e[4 + i], e[8 + i], e[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const combo = (
    a: [number, number, number, number],
    b: [number, number, number, number],
    sign: 1 | -1
  ): Plane => {
    const p: Plane = {
      a: a[0] + sign * b[0],
      b: a[1] + sign * b[1],
      c: a[2] + sign * b[2],
      d: a[3] + sign * b[3],
    };
    const len = Math.hypot(p.a, p.b, p.c) || 1;
    p.a /= len; p.b /= len; p.c /= len; p.d /= len;
    return p;
  };
  return [
    combo(r3, r0, 1), // left
    combo(r3, r0, -1), // right
    combo(r3, r1, 1), // bottom
    combo(r3, r1, -1), // top
    combo(r3, r2, 1), // near
    combo(r3, r2, -1), // far
  ];
}

export function testSphere(
  planes: Plane[],
  cx: number, cy: number, cz: number,
  r: number
): boolean {
  for (const p of planes) {
    if (p.a * cx + p.b * cy + p.c * cz + p.d < -r) return false;
  }
  return true;
}
