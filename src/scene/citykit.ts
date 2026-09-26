// Glitch city kit — procedural street-level props from boxes.
// Original designs: houses with stepped roofs, pines, power poles with wire
// runs, shops with sign boards, gas-station canopies, parked cars, fences,
// piers, distant mountains. Thin items are visual-only (no colliders) so the
// player never gets stuck on dressing.

import { World, type Entity } from "../ecs/world.js";
import { Vec3 } from "../math/vec3.js";
import { makeTransform, type MeshRef } from "../ecs/components.js";

type C = [number, number, number];

export function box(
  world: World, x: number, y: number, z: number,
  sx: number, sy: number, sz: number, color: C,
  opts: { tex?: string; solid?: boolean; ry?: number } = {}
): Entity {
  const e = world.create();
  const t = makeTransform(x, y, z);
  t.scale.set(sx, sy, sz);
  if (opts.ry) t.rotationY = opts.ry;
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color, textureId: opts.tex });
  if (opts.solid) {
    world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });
    world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: false, mass: 0, grounded: true });
  }
  return e;
}

// House: solid base + stepped pyramid roof + door + bright windows.
export function house(world: World, x: number, z: number, w: number, d: number, wallH: number, wall: C, roof: C, ry = 0, wallTex?: string, roofTex?: string) {
  box(world, x, wallH / 2, z, w, wallH, d, wall, { solid: true, tex: wallTex ?? "checker", ry });
  box(world, x, wallH + 0.4, z, w * 0.78, 0.8, d * 0.78, roof, { tex: roofTex, ry });
  box(world, x, wallH + 1.1, z, w * 0.5, 0.7, d * 0.5, roof, { tex: roofTex, ry });
  // door faces +z (or rotated with ry — keep axis aligned, ry is 0 or PI/2 style use)
  const c = Math.cos(ry), s = Math.sin(ry);
  const fx = s, fz = c; // forward
  box(world, x + fx * (d / 2 + 0.06), 1.0, z + fz * (d / 2 + 0.06), 0.9, 2.0, 0.12, [0.12, 0.1, 0.1], { ry });
  for (const side of [-1, 1]) {
    box(world,
      x + fx * (d / 2 + 0.06) + c * side * (w / 4), 1.6, z + fz * (d / 2 + 0.06) + s * side * (w / 4),
      1.1, 1.0, 0.12, [1.0, 0.82, 0.5], { ry });
  }
}

// Pine: trunk + three stacked foliage boxes. y0 lifts the base (hillsides).
export function pine(world: World, x: number, z: number, s = 1, y0 = 0) {
  box(world, x, y0 + 1.0 * s, z, 0.5 * s, 2.0 * s, 0.5 * s, [0.32, 0.22, 0.15]);
  const greens: C[] = [[0.1, 0.32, 0.14], [0.12, 0.38, 0.16], [0.15, 0.44, 0.18]];
  for (let i = 0; i < 3; i++) {
    const w = (3.4 - i * 0.9) * s;
    box(world, x, y0 + (2.2 + i * 1.3) * s, z, w, 1.5 * s, w, greens[i]);
  }
}

// Power pole with crossarm; wireRun strings thin boxes between pole tops.
export function pole(world: World, x: number, z: number, h = 7) {
  box(world, x, h / 2, z, 0.3, h, 0.3, [0.25, 0.18, 0.12]);
  box(world, x, h - 0.6, z, 2.2, 0.18, 0.18, [0.25, 0.18, 0.12]);
}

export function wireRun(world: World, x1: number, z1: number, x2: number, z2: number, h = 6.4, step = 8) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const n = Math.max(2, Math.round(len / step) + 1);
  let px = x1, pz = z1;
  for (let i = 0; i < n; i++) {
    const x = x1 + (dx * i) / (n - 1), z = z1 + (dz * i) / (n - 1);
    pole(world, x, z, h + 0.6);
    if (i > 0) {
      const mx = (px + x) / 2, mz = (pz + z) / 2;
      const seg = Math.hypot(x - px, z - pz);
      const e = box(world, mx, h, mz, 0.07, 0.07, seg, [0.08, 0.08, 0.09]);
      const t = world.get<ReturnType<typeof makeTransform>>(e, "transform");
      if (t) t.rotationY = Math.atan2(x - px, z - pz);
    }
    px = x; pz = z;
  }
}

// Fence run: posts + two rails. Visual only.
export function fenceRun(world: World, x1: number, z1: number, x2: number, z2: number, h = 1.4, color: C = [0.55, 0.55, 0.58]) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const n = Math.max(2, Math.round(len / 2.5) + 1);
  for (let i = 0; i < n; i++) {
    box(world, x1 + (dx * i) / (n - 1), h / 2, z1 + (dz * i) / (n - 1), 0.16, h, 0.16, color);
  }
  for (const fy of [h * 0.35, h * 0.8]) {
    const e = box(world, (x1 + x2) / 2, fy, (z1 + z2) / 2, 0.08, 0.12, len, color);
    const t = world.get<ReturnType<typeof makeTransform>>(e, "transform");
    if (t) t.rotationY = Math.atan2(dx, dz);
  }
}

// Shop: solid block + awning + bright sign board + glass front.
export function shop(world: World, x: number, z: number, w: number, h: number, d: number, base: C, sign: C, ry = 0, wallTex?: string, signTex?: string) {
  box(world, x, h / 2, z, w, h, d, base, { solid: true, tex: wallTex ?? "checker", ry });
  const c = Math.cos(ry), s = Math.sin(ry);
  const fx = s, fz = c;
  box(world, x + fx * (d / 2 + 0.5), h * 0.62, z + fz * (d / 2 + 0.5), w * 0.9, 0.25, 1.4, sign, { ry });
  box(world, x + fx * (d / 2 + 0.15), h * 0.82, z + fz * (d / 2 + 0.15), w * 0.7, 0.7, 0.2, sign, signTex ? { tex: signTex } : undefined);
  box(world, x + fx * (d / 2 + 0.04), h * 0.4, z + fz * (d / 2 + 0.04), w * 0.8, h * 0.55, 0.1, [0.12, 0.16, 0.2], { ry });
}

// Gas station: canopy on pillars + pumps + totem sign.
export function gasStation(world: World, x: number, z: number, brand: C) {
  for (const [ox, oz] of [[-3, -2], [3, -2], [-3, 2], [3, 2]] as [number, number][]) {
    box(world, x + ox, 2.2, z + oz, 0.4, 4.4, 0.4, [0.2, 0.2, 0.22], { solid: true });
  }
  box(world, x, 4.7, z, 8.5, 0.5, 6, brand);
  box(world, x, 4.35, z, 8.5, 0.15, 6, [1.0, 0.85, 0.5]);
  for (const ox of [-1.5, 1.5]) {
    box(world, x + ox, 0.7, z, 0.8, 1.4, 0.6, [0.75, 0.15, 0.12], { solid: true });
    box(world, x + ox, 1.55, z, 0.9, 0.25, 0.7, [0.9, 0.9, 0.9]);
  }
  box(world, x + 6, 3, z + 3.5, 0.5, 6, 0.5, [0.2, 0.2, 0.22], { solid: true });
  box(world, x + 6, 5.2, z + 3.5, 2.4, 1.2, 0.4, brand);
}

// Parked car: body + cabin + wheels. Solid.
export function car(world: World, x: number, z: number, ry: number, color: C) {
  const e = box(world, x, 0.65, z, 2.0, 0.75, 4.4, color, { solid: true, ry });
  void e;
  const c = Math.cos(ry), s = Math.sin(ry);
  box(world, x - s * 0.2, 1.35, z - c * 0.2, 1.7, 0.65, 2.2, [0.1, 0.13, 0.16], { ry });
  for (const [ox, oz] of [[-0.95, -1.4], [0.95, -1.4], [-0.95, 1.4], [0.95, 1.4]] as [number, number][]) {
    const wx = x + c * ox + s * oz, wz = z - s * ox + c * oz;
    box(world, wx, 0.4, wz, 0.4, 0.8, 0.8, [0.07, 0.07, 0.08]);
  }
}

export function dumpster(world: World, x: number, z: number, ry = 0) {
  box(world, x, 0.8, z, 2.2, 1.6, 1.2, [0.16, 0.4, 0.18], { solid: true, ry });
  box(world, x, 1.65, z, 2.3, 0.15, 1.3, [0.1, 0.25, 0.12], { ry });
}

export function mailbox(world: World, x: number, z: number) {
  box(world, x, 0.6, z, 0.12, 1.2, 0.12, [0.5, 0.5, 0.52]);
  box(world, x, 1.3, z, 0.5, 0.35, 0.3, [0.15, 0.25, 0.6]);
}

export function cone(world: World, x: number, z: number) {
  box(world, x, 0.35, z, 0.5, 0.7, 0.5, [0.95, 0.45, 0.1]);
  box(world, x, 0.75, z, 0.3, 0.2, 0.3, [0.95, 0.9, 0.85]);
}

export function bollard(world: World, x: number, z: number) {
  box(world, x, 0.5, z, 0.3, 1.0, 0.3, [0.85, 0.7, 0.1], { solid: true });
}

// Road dashes along one axis.
export function dashes(world: World, fixed: number, from: number, to: number, horiz: boolean, step = 4) {
  for (let v = from; v <= to; v += step) {
    if (horiz) box(world, v, 0.035, fixed, 1.6, 0.02, 0.25, [0.75, 0.75, 0.72]);
    else box(world, fixed, 0.035, v, 0.25, 0.02, 1.6, [0.75, 0.75, 0.72]);
  }
}

// Zebra crosswalk across a road.
export function crosswalk(world: World, x: number, z: number, horiz: boolean) {
  for (let i = -3; i <= 3; i++) {
    if (horiz) box(world, x + i * 1.1, 0.035, z, 0.6, 0.02, 3.4, [0.8, 0.8, 0.78]);
    else box(world, x, 0.035, z + i * 1.1, 3.4, 0.02, 0.6, [0.8, 0.8, 0.78]);
  }
}

// Sidewalk strip.
export function sidewalk(world: World, x: number, z: number, sx: number, sz: number) {
  box(world, x, 0.02, z, sx, 0.06, sz, [0.32, 0.33, 0.36]);
}

// Open-frame construction skeleton: corner posts + top beams + deck slab.
export function siteFrame(world: World, x: number, z: number, w: number, d: number, h: number) {
  const post: C = [0.3, 0.2, 0.14];
  for (const [ox, oz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]] as [number, number][]) {
    box(world, x + ox, h / 2, z + oz, 0.4, h, 0.4, post, { solid: true });
  }
  box(world, x, h, z, w + 0.4, 0.4, 0.4, post);
  box(world, x, h, z, 0.4, 0.4, d + 0.4, post);
  box(world, x, h / 2, z, w * 0.9, 0.3, d * 0.9, [0.45, 0.38, 0.3]);
  // material piles + cones
  box(world, x + w / 2 + 2, 0.5, z + 1, 2, 1, 1.5, [0.5, 0.38, 0.25], { solid: true });
  cone(world, x - w / 2 - 2, z + 2);
  cone(world, x - w / 2 - 2, z - 2);
}

// Pier deck over water + posts.
export function pier(world: World, x1: number, z: number, x2: number) {
  const len = Math.abs(x2 - x1);
  const mx = (x1 + x2) / 2;
  box(world, mx, 0.55, z, len, 0.25, 3, [0.4, 0.3, 0.2]);
  for (let x = Math.min(x1, x2) + 2; x < Math.max(x1, x2); x += 4) {
    box(world, x, 0.1, z - 1.6, 0.25, 1.2, 0.25, [0.25, 0.2, 0.15]);
    box(world, x, 0.1, z + 1.6, 0.25, 1.2, 0.25, [0.25, 0.2, 0.15]);
    box(world, x, 1.35, z - 1.6, 0.25, 0.5, 0.25, [0.25, 0.2, 0.15]);
    box(world, x, 1.35, z + 1.6, 0.25, 0.5, 0.25, [0.25, 0.2, 0.15]);
  }
  box(world, mx, 1.15, z - 1.6, len, 0.12, 0.12, [0.3, 0.24, 0.17]);
  box(world, mx, 1.15, z + 1.6, len, 0.12, 0.12, [0.3, 0.24, 0.17]);
}

// Distant mountain silhouettes (haze does the rest).
export function mountains(world: World) {
  const spots: [number, number, number, number][] = [
    [-90, -70, 50, 26], [-30, -95, 60, 32], [40, -90, 55, 24], [95, -55, 45, 22],
    [110, 20, 50, 26], [90, 85, 55, 24], [20, 105, 60, 28], [-60, 95, 50, 22], [-105, 30, 45, 24],
  ];
  for (const [x, z, w, h] of spots) {
    box(world, x, h / 2 - 1, z, w, h, 18, [0.13, 0.16, 0.2]);
  }
}
