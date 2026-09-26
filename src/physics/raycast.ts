import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import type { BoxCollider, SphereCollider, Transform } from "../ecs/components.js";
import { getLayer, layerBit } from "./layers.js";

export interface Ray {
  origin: Vec3;
  direction: Vec3; // normalized
  maxDist: number;
}

export interface RayHit {
  entity: Entity;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export interface RayOptions {
  mask?: number; // only entities whose layer bit is set collide
  ignore?: Entity; // e.g. the shooter's own body
}

function slab(o: number, d: number, min: number, max: number): [number, number] | null {
  if (Math.abs(d) < 1e-8) {
    return o >= min && o <= max ? [-Infinity, Infinity] : null;
  }
  let t1 = (min - o) / d;
  let t2 = (max - o) / d;
  if (t1 > t2) [t1, t2] = [t2, t1];
  return [t1, t2];
}

export function rayVsBox(ray: Ray, t: Transform, c: BoxCollider): number | null {
  const hit = rayVsBoxFull(ray, t, c);
  return hit === null ? null : hit.d;
}

interface BoxHit {
  d: number;
  n: Vec3;
}

function rayVsBoxFull(ray: Ray, t: Transform, c: BoxCollider): BoxHit | null {
  const min = {
    x: t.position.x - c.halfExtents.x * t.scale.x,
    y: t.position.y - c.halfExtents.y * t.scale.y,
    z: t.position.z - c.halfExtents.z * t.scale.z,
  };
  const max = {
    x: t.position.x + c.halfExtents.x * t.scale.x,
    y: t.position.y + c.halfExtents.y * t.scale.y,
    z: t.position.z + c.halfExtents.z * t.scale.z,
  };
  const sx = slab(ray.origin.x, ray.direction.x, min.x, max.x);
  const sy = slab(ray.origin.y, ray.direction.y, min.y, max.y);
  const sz = slab(ray.origin.z, ray.direction.z, min.z, max.z);
  if (!sx || !sy || !sz) return null;
  const tmin = Math.max(sx[0], sy[0], sz[0]);
  const tmax = Math.min(sx[1], sy[1], sz[1]);
  if (tmax < Math.max(0, tmin) || tmin > ray.maxDist) return null;
  const d = Math.max(0, tmin);
  // Face normal: nearest box face to the hit point.
  const px = ray.origin.x + ray.direction.x * d;
  const py = ray.origin.y + ray.direction.y * d;
  const pz = ray.origin.z + ray.direction.z * d;
  const faces: { dist: number; n: Vec3 }[] = [
    { dist: Math.abs(px - min.x), n: new Vec3(-1, 0, 0) },
    { dist: Math.abs(max.x - px), n: new Vec3(1, 0, 0) },
    { dist: Math.abs(py - min.y), n: new Vec3(0, -1, 0) },
    { dist: Math.abs(max.y - py), n: new Vec3(0, 1, 0) },
    { dist: Math.abs(pz - min.z), n: new Vec3(0, 0, -1) },
    { dist: Math.abs(max.z - pz), n: new Vec3(0, 0, 1) },
  ];
  let best = faces[0];
  for (const f of faces) if (f.dist < best.dist) best = f;
  return { d, n: best.n };
}

export function rayVsSphere(ray: Ray, center: Vec3, r: number): number | null {
  const ox = ray.origin.x - center.x;
  const oy = ray.origin.y - center.y;
  const oz = ray.origin.z - center.z;
  const b = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > ray.maxDist) return null; // starts inside: no hit (documented)
  return t;
}

function at(ray: Ray, d: number): Vec3 {
  return new Vec3(
    ray.origin.x + ray.direction.x * d,
    ray.origin.y + ray.direction.y * d,
    ray.origin.z + ray.direction.z * d
  );
}

export function raycastScene(world: World, ray: Ray, opts: RayOptions = {}): RayHit | null {
  let best: RayHit | null = null;
  const consider = (e: Entity, d: number, n: Vec3) => {
    if (!best || d < best.distance) {
      best = { entity: e, distance: d, point: at(ray, d), normal: n };
    }
  };
  const passes = (e: Entity): boolean => {
    if (opts.ignore !== undefined && e === opts.ignore) return false;
    if (opts.mask !== undefined && (opts.mask & layerBit(getLayer(world, e))) === 0) return false;
    return true;
  };
  for (const e of world.query("transform", "collider")) {
    if (!passes(e)) continue;
    const t = world.get<Transform>(e, "transform")!;
    const c = world.get<BoxCollider>(e, "collider")!;
    const hit = rayVsBoxFull(ray, t, c);
    if (hit) consider(e, hit.d, hit.n);
  }
  for (const e of world.query("transform", "sphere")) {
    if (!passes(e)) continue;
    const t = world.get<Transform>(e, "transform")!;
    const s = world.get<SphereCollider>(e, "sphere")!;
    const r = s.radius * Math.max(t.scale.x, t.scale.y, t.scale.z);
    const d = rayVsSphere(ray, t.position, r);
    if (d === null) continue;
    const p = at(ray, d);
    const n = new Vec3(p.x - t.position.x, p.y - t.position.y, p.z - t.position.z).normalize();
    consider(e, d, n);
  }
  return best;
}
