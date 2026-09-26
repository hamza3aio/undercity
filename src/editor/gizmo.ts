// Glitch gizmo math — viewport picking + axis-drag, pure functions.
// Screen space: origin top-left, y down. World matrices are column-major
// (Mat4). Axis colors/semantics are UI-layer concerns, not here.

import { Mat4 } from "../math/mat4.js";
import { Vec3 } from "../math/vec3.js";

export interface ScreenPoint {
  x: number;
  y: number;
  behind: boolean;
}

export interface Ray {
  origin: Vec3;
  dir: Vec3; // normalized
}

export function viewProj(view: Mat4, proj: Mat4): Mat4 {
  return proj.clone().multiply(view);
}

function transformPoint(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
  const e = m.elements;
  return {
    x: e[0] * x + e[4] * y + e[8] * z + e[12],
    y: e[1] * x + e[5] * y + e[9] * z + e[13],
    z: e[2] * x + e[6] * y + e[10] * z + e[14],
    w: e[3] * x + e[7] * y + e[11] * z + e[15],
  };
}

export function worldToScreen(vp: Mat4, width: number, height: number, p: Vec3): ScreenPoint {
  const c = transformPoint(vp, p.x, p.y, p.z);
  if (c.w <= 0) return { x: -1, y: -1, behind: true };
  const nx = c.x / c.w, ny = c.y / c.w;
  return { x: (nx * 0.5 + 0.5) * width, y: (1 - (ny * 0.5 + 0.5)) * height, behind: false };
}

// Unproject an NDC point at clip depth z (-1 near, +1 far) into the world.
// Returns null for singular view-projection.
export function unproject(vp: Mat4, nx: number, ny: number, nz: number): Vec3 | null {
  const inv = vp.invert();
  if (!inv) return null;
  const c = transformPoint(inv, nx, ny, nz);
  if (Math.abs(c.w) < 1e-9) return null;
  return new Vec3(c.x / c.w, c.y / c.w, c.z / c.w);
}

export function screenRay(vp: Mat4, width: number, height: number, sx: number, sy: number): Ray | null {
  const nx = (sx / width) * 2 - 1;
  const ny = 1 - (sy / height) * 2;
  const near = unproject(vp, nx, ny, -1);
  const far = unproject(vp, nx, ny, 1);
  if (!near || !far) return null;
  return { origin: near, dir: far.sub(near).normalize() };
}

// Closest approach between a ray and an axis line. Returns the axis
// parameter delta source (axisT) — callers diff two calls for drags.
// Null when ray and axis are (near-)parallel.
export function axisParam(
  rayOrigin: Vec3, rayDir: Vec3,
  axisPoint: Vec3, axisDir: Vec3
): { rayT: number; axisT: number } | null {
  const wx = rayOrigin.x - axisPoint.x;
  const wy = rayOrigin.y - axisPoint.y;
  const wz = rayOrigin.z - axisPoint.z;
  const b = rayDir.x * axisDir.x + rayDir.y * axisDir.y + rayDir.z * axisDir.z;
  const d = rayDir.x * wx + rayDir.y * wy + rayDir.z * wz;
  const e = axisDir.x * wx + axisDir.y * wy + axisDir.z * wz;
  const denom = 1 - b * b; // |rayDir| == |axisDir| == 1
  if (Math.abs(denom) < 1e-8) return null;
  return { rayT: (b * e - d) / denom, axisT: (e - b * d) / denom };
}

export function distPointToSegment2D(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.hypot(cx, cy);
}

export function snapValue(v: number, step: number): number {
  if (!(step > 0)) return v;
  return Math.round(v / step) * step;
}
