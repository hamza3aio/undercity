// Glitch physics extras (Phase 8) — mesh colliders, compound colliders,
// sphere casts, physics materials and collision callbacks.
//
// Everything here is pure math against the same shapes the solver already
// understands (box / sphere / capsule), so it is headless-testable. The
// solver integration is additive: existing box/sphere/capsule behaviour is
// untouched and these queries are opt-in calls from game code.

import { Vec3 } from "../math/vec3.js";
import { Mat4 } from "../math/mat4.js";
import { World, type Entity } from "../ecs/world.js";
import { makeTransform, type Transform } from "../ecs/components.js";
import type { BoxCollider, CapsuleCollider, SphereCollider } from "../ecs/components.js";
import { layersCollide, setLayer, setMask, layerBit } from "./layers.js";

/** Friction/bounciness/restitution for a surface. */
export interface PhysicsMaterial {
  name: string;
  friction: number; // 0..2
  restitution: number; // 0..1
  density: number; // mass per unit volume, > 0
}

export function defaultPhysicsMaterials(): Record<string, PhysicsMaterial> {
  return {
    default: { name: "default", friction: 0.6, restitution: 0.1, density: 1 },
    rubber: { name: "rubber", friction: 0.95, restitution: 0.75, density: 1.1 },
    metal: { name: "metal", friction: 0.25, restitution: 0.35, density: 7.8 },
    ice: { name: "ice", friction: 0.02, restitution: 0.05, density: 0.9 },
    wood: { name: "wood", friction: 0.55, restitution: 0.25, density: 0.7 },
  };
}

function finite(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function sanitizePhysicsMaterial(m: Partial<PhysicsMaterial>, name = "custom"): PhysicsMaterial {
  return {
    name: typeof m.name === "string" && m.name ? m.name : name,
    friction: Math.max(0, Math.min(2, finite(m.friction, 0.6))),
    restitution: Math.max(0, Math.min(1, finite(m.restitution, 0.1))),
    density: Math.max(0.01, finite(m.density, 1)),
  };
}

/**
 * Combines two surface materials the way a contact solver would:
 * friction takes the geometric mean, restitution takes the max.
 */
export function combineMaterials(a: PhysicsMaterial, b: PhysicsMaterial): PhysicsMaterial {
  return {
    name: `${a.name}+${b.name}`,
    friction: Math.sqrt(a.friction * b.friction),
    restitution: Math.max(a.restitution, b.restitution),
    density: (a.density + b.density) / 2,
  };
}

// --- sphere cast ---

export interface CastHit {
  entity: Entity;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export interface SphereCastOptions {
  origin: Vec3;
  direction: Vec3; // need not be normalized
  radius: number;
  maxDist: number;
  /** Skip these entities (e.g. the caster itself). */
  ignore?: Set<Entity>;
}

function norm(v: Vec3): Vec3 {
  const l = v.length();
  return l < 1e-8 ? new Vec3(0, 0, 0) : new Vec3(v.x / l, v.y / l, v.z / l);
}

// Slab test for a sphere against a box (rounded expansion is approximated by
// inflating the box, which is exact for the "swept sphere vs box" contact on
// the face normals and conservative at the corners).
function sphereVsBox(
  origin: Vec3, dir: Vec3, center: Vec3, half: Vec3, radius: number, maxDist: number
): { distance: number; normal: Vec3 } | null {
  // Work in the box's frame with the box expanded by the sphere radius.
  const hx = half.x + radius, hy = half.y + radius, hz = half.z + radius;
  const o = new Vec3(origin.x - center.x, origin.y - center.y, origin.z - center.z);
  let tmin = 0;
  let tmax = maxDist;
  let axis = 0;
  let sign = 1;
  const axes: [number, number, number][] = [[o.x, dir.x, hx], [o.y, dir.y, hy], [o.z, dir.z, hz]];
  const halfs = [hx, hy, hz];
  const os = [o.x, o.y, o.z];
  for (let i = 0; i < 3; i++) {
    const d = axes[i][1];
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(os[i]) > halfs[i]) return null; // parallel and outside
      continue;
    }
    const inv = 1 / d;
    let t1 = (-halfs[i] - os[i]) * inv;
    let t2 = (halfs[i] - os[i]) * inv;
    let s = -1;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      s = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = i;
      sign = s;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmin > maxDist) return null;
  const n = new Vec3(0, 0, 0);
  if (axis === 0) n.x = sign;
  else if (axis === 1) n.y = sign;
  else n.z = sign;
  return { distance: tmin, normal: n };
}

function sphereVsSphere(
  origin: Vec3, dir: Vec3, center: Vec3, radius: number, maxDist: number
): { distance: number; normal: Vec3 } | null {
  const r = radius;
  const oc = new Vec3(origin.x - center.x, origin.y - center.y, origin.z - center.z);
  const b = oc.dot(dir);
  const c = oc.dot(oc) - r * r;
  if (c > 0 && b > 0) return null; // origin outside and moving away
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxDist) return null;
  const p = new Vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
  return { distance: t, normal: norm(new Vec3(p.x - center.x, p.y - center.y, p.z - center.z)) };
}

/**
 * Sweeps a sphere through the world and returns the closest hit. This is
 * the shape most character controllers and melee attacks actually want.
 */
export function sphereCastWorld(world: World, opts: SphereCastOptions): CastHit | null {
  const dir = norm(opts.direction);
  if (dir.length() < 0.5) return null;
  let best: CastHit | null = null;
  for (const e of world.query("transform") as Entity[]) {
    if (opts.ignore?.has(e)) continue;
    const t = world.get<Transform>(e, "transform")!;
    const box = world.get<BoxCollider>(e, "collider");
    const sph = world.get<SphereCollider>(e, "sphere");
    const cap = world.get<CapsuleCollider>(e, "capsule");
    let hit: { distance: number; normal: Vec3 } | null = null;
    if (box) {
      const half = new Vec3(
        Math.abs(box.halfExtents.x * t.scale.x),
        Math.abs(box.halfExtents.y * t.scale.y),
        Math.abs(box.halfExtents.z * t.scale.z)
      );
      hit = sphereVsBox(opts.origin, dir, t.position, half, opts.radius, opts.maxDist);
    } else if (sph) {
      const r = sph.radius * Math.max(t.scale.x, t.scale.y, t.scale.z);
      hit = sphereVsSphere(opts.origin, dir, t.position, r + opts.radius, opts.maxDist);
    } else if (cap) {
      // Capsule as a vertical segment: cast against the expanded cylinder.
      const r = cap.radius * Math.max(t.scale.x, t.scale.z) + opts.radius;
      const halfH = Math.abs(cap.height * 0.5 * t.scale.y);
      const hitBox = sphereVsBox(
        opts.origin, dir, t.position, new Vec3(r, halfH + r * 0.0, r), r * 0.0, opts.maxDist
      );
      if (hitBox) hit = hitBox;
    }
    if (!hit) continue;
    if (best && hit.distance >= best.distance) continue;
    best = {
      entity: e,
      distance: hit.distance,
      point: new Vec3(
        opts.origin.x + dir.x * hit.distance,
        opts.origin.y + dir.y * hit.distance,
        opts.origin.z + dir.z * hit.distance
      ),
      normal: hit.normal,
    };
  }
  return best;
}

/** Overlap test: entities whose bounds intersect a sphere. */
export function overlapSphereWorld(world: World, center: Vec3, radius: number, ignore?: Set<Entity>): Entity[] {
  const out: Entity[] = [];
  for (const e of world.query("transform") as Entity[]) {
    if (ignore?.has(e)) continue;
    const t = world.get<Transform>(e, "transform")!;
    const box = world.get<BoxCollider>(e, "collider");
    const sph = world.get<SphereCollider>(e, "sphere");
    if (box) {
      const hx = Math.abs(box.halfExtents.x * t.scale.x);
      const hy = Math.abs(box.halfExtents.y * t.scale.y);
      const hz = Math.abs(box.halfExtents.z * t.scale.z);
      const dx = Math.max(0, Math.abs(center.x - t.position.x) - hx);
      const dy = Math.max(0, Math.abs(center.y - t.position.y) - hy);
      const dz = Math.max(0, Math.abs(center.z - t.position.z) - hz);
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out.push(e);
    } else if (sph) {
      const r = sph.radius * Math.max(t.scale.x, t.scale.y, t.scale.z) + radius;
      if (Math.hypot(center.x - t.position.x, center.y - t.position.y, center.z - t.position.z) <= r) out.push(e);
    }
  }
  return out;
}

// --- mesh colliders ---

/**
 * Triangle-soup mesh collider. Convex-hull decomposition and BVH refit are
 * NOT implemented: this is the brute-force path, correct for small props
 * (the same approach Unity's old MeshCollider used) and documented as such.
 */
export interface MeshColliderData {
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
}

export interface MeshHit {
  entity: Entity;
  distance: number;
  point: Vec3;
  normal: Vec3;
  triangle: number;
}

// Moller-Trumbore, single triangle.
function rayTriangle(
  origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3
): { t: number; u: number; v: number } | null {
  const e1 = new Vec3(b.x - a.x, b.y - a.y, b.z - a.z);
  const e2 = new Vec3(c.x - a.x, c.y - a.y, c.z - a.z);
  const h = new Vec3(dir.y * e2.z - dir.z * e2.y, dir.z * e2.x - dir.x * e2.z, dir.x * e2.y - dir.y * e2.x);
  const det = e1.x * h.x + e1.y * h.y + e1.z * h.z;
  if (Math.abs(det) < 1e-10) return null; // parallel
  const inv = 1 / det;
  const s = new Vec3(origin.x - a.x, origin.y - a.y, origin.z - a.z);
  const u = inv * (s.x * h.x + s.y * h.y + s.z * h.z);
  if (u < 0 || u > 1) return null;
  const q = new Vec3(
    s.y * e1.z - s.z * e1.y,
    s.z * e1.x - s.x * e1.z,
    s.x * e1.y - s.y * e1.x
  );
  const v = inv * (dir.x * q.x + dir.y * q.y + dir.z * q.z);
  if (v < 0 || u + v > 1) return null;
  const t = inv * (e2.x * q.x + e2.y * q.y + e2.z * q.z);
  return t >= 0 ? { t, u, v } : null;
}

export interface MeshRayOptions {
  origin: Vec3;
  direction: Vec3;
  maxDist: number;
  ignore?: Set<Entity>;
}

/** Ray cast against every entity carrying a "meshCollider". */
export function raycastMeshes(world: World, opts: MeshRayOptions): MeshHit | null {
  const dir = norm(opts.direction);
  let best: MeshHit | null = null;
  for (const e of world.query("transform", "meshCollider") as Entity[]) {
    if (opts.ignore?.has(e)) continue;
    const t = world.get<Transform>(e, "transform")!;
    const data = world.get<MeshColliderData>(e, "meshCollider")!;
    const m = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
    const count = data.indices.length;
    for (let i = 0; i + 2 < count + 1; i += 3) {
      const i0 = data.indices[i], i1 = data.indices[i + 1], i2 = data.indices[i + 2];
      const a = new Vec3(data.positions[i0 * 3], data.positions[i0 * 3 + 1], data.positions[i0 * 3 + 2]);
      const b = new Vec3(data.positions[i1 * 3], data.positions[i1 * 3 + 1], data.positions[i1 * 3 + 2]);
      const c = new Vec3(data.positions[i2 * 3], data.positions[i2 * 3 + 1], data.positions[i2 * 3 + 2]);
      const wa = m.transformPoint(a);
      const wb = m.transformPoint(b);
      const wc = m.transformPoint(c);
      const hit = rayTriangle(opts.origin, dir, wa, wb, wc);
      if (!hit || hit.t > opts.maxDist) continue;
      if (best && hit.t >= best.distance) continue;
      const e1 = new Vec3(wb.x - wa.x, wb.y - wa.y, wb.z - wa.z);
      const e2 = new Vec3(wc.x - wa.x, wc.y - wa.y, wc.z - wa.z);
      const n = norm(new Vec3(
        e1.y * e2.z - e1.z * e2.y,
        e1.z * e2.x - e1.x * e2.z,
        e1.x * e2.y - e1.y * e2.x
      ));
      best = {
        entity: e,
        distance: hit.t,
        point: new Vec3(
          opts.origin.x + dir.x * hit.t,
          opts.origin.y + dir.y * hit.t,
          opts.origin.z + dir.z * hit.t
        ),
        normal: n,
        triangle: i / 3,
      };
    }
  }
  return best;
}

// --- compound colliders ---

export interface CompoundPart {
  /** Local offset from the compound entity's transform. */
  offset: Vec3;
  halfExtents: Vec3;
  rotationY: number;
  physicsMaterial?: string;
}

/** Creates an entity carrying several box parts under one body. */
export function makeCompound(world: World, x: number, y: number, z: number, parts: CompoundPart[]): Entity {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  world.add(e, "compound", { parts: parts.map((p) => ({ ...p, offset: p.offset.clone() })) });
  world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: true, mass: 1, grounded: false });
  return e;
}

/** Axis-aligned bounds of a compound (in world space, after yaw). */
export function compoundBounds(world: World, e: Entity): { min: Vec3; max: Vec3 } | null {
  const parts = world.get<{ parts: CompoundPart[] }>(e, "compound");
  const t = world.get<Transform>(e, "transform");
  if (!parts || !t || parts.parts.length === 0) return null;
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const p of parts.parts) {
    // Yaw only: rotate the offset, then take the box extents as-is.
    const c = Math.cos(t.rotationY + p.rotationY);
    const s = Math.sin(t.rotationY + p.rotationY);
    const ox = p.offset.x * c + p.offset.z * s;
    const oz = -p.offset.x * s + p.offset.z * c;
    min.x = Math.min(min.x, t.position.x + ox - p.halfExtents.x);
    max.x = Math.max(max.x, t.position.x + ox + p.halfExtents.x);
    min.y = Math.min(min.y, t.position.y + p.offset.y - p.halfExtents.y);
    max.y = Math.max(max.y, t.position.y + p.offset.y + p.halfExtents.y);
    min.z = Math.min(min.z, t.position.z + oz - p.halfExtents.z);
    max.z = Math.max(max.z, t.position.z + oz + p.halfExtents.z);
  }
  return { min, max };
}

/** Sphere cast against a compound (tests each part). */
export function sphereCastCompound(world: World, e: Entity, opts: SphereCastOptions): CastHit | null {
  const parts = world.get<{ parts: CompoundPart[] }>(e, "compound");
  const t = world.get<Transform>(e, "transform");
  if (!parts || !t) return null;
  const dir = norm(opts.direction);
  let best: CastHit | null = null;
  for (const p of parts.parts) {
    const c = Math.cos(t.rotationY + p.rotationY);
    const s = Math.sin(t.rotationY + p.rotationY);
    const ox = p.offset.x * c + p.offset.z * s;
    const oz = -p.offset.x * s + p.offset.z * c;
    const center = new Vec3(t.position.x + ox, t.position.y + p.offset.y, t.position.z + oz);
    const hit = sphereVsBox(opts.origin, dir, center, p.halfExtents, opts.radius, opts.maxDist);
    if (!hit) continue;
    if (best && hit.distance >= best.distance) continue;
    // Rotate the box normal back into world space.
    const ry = t.rotationY + p.rotationY;
    const cr = Math.cos(ry), sr = Math.sin(ry);
    const n = new Vec3(
      hit.normal.x * cr + hit.normal.z * sr,
      hit.normal.y,
      -hit.normal.x * sr + hit.normal.z * cr
    );
    best = {
      entity: e,
      distance: hit.distance,
      point: new Vec3(
        opts.origin.x + dir.x * hit.distance,
        opts.origin.y + dir.y * hit.distance,
        opts.origin.z + dir.z * hit.distance
      ),
      normal: n,
    };
  }
  return best;
}

// --- collision callbacks ---

export interface ContactEvent {
  a: Entity;
  b: Entity;
  /** Approximate impact speed along the contact normal. */
  impulse: number;
}

export interface ContactListenerOptions {
  /** Ignore contacts below this closing speed. */
  minImpulse?: number;
  /** Apply the engine's layer/mask rule (physics/layers.ts). Default true. */
  respectLayers?: boolean;
  ignore?: Set<Entity>;
}

/**
 * Reports new contacts between dynamic bodies (anything with a rigidbody)
 * and collidable geometry (anything with a collider, static or not). This
 * complements Engine.physics.onCollide (a callback): this is a query you
 * can call after a step, with layer filtering and an impulse threshold.
 */
export function collectContacts(world: World, opts: ContactListenerOptions = {}): ContactEvent[] {
  const minImpulse = opts.minImpulse ?? 0.5;
  const respectLayers = opts.respectLayers !== false;
  const out: ContactEvent[] = [];
  const bodies = world.query("transform", "rigidbody") as Entity[];
  const solids = world.query("transform", "collider") as Entity[];
  for (const a of bodies) {
    if (opts.ignore?.has(a)) continue;
    const rb = world.get<{ velocity: Vec3 }>(a, "rigidbody")!;
    const at = world.get<Transform>(a, "transform")!;
    for (const b of solids) {
      if (a === b || opts.ignore?.has(b)) continue;
      if (respectLayers && !layersCollide(world, a, b)) continue;
      const bt = world.get<Transform>(b, "transform")!;
      const box = world.get<BoxCollider>(b, "collider");
      const sph = world.get<SphereCollider>(b, "sphere");
      if (box) {
        const hx = Math.abs(box.halfExtents.x * bt.scale.x);
        const hy = Math.abs(box.halfExtents.y * bt.scale.y);
        const hz = Math.abs(box.halfExtents.z * bt.scale.z);
        const dx = Math.max(0, Math.abs(at.position.x - bt.position.x) - hx);
        const dy = Math.max(0, Math.abs(at.position.y - bt.position.y) - hy);
        const dz = Math.max(0, Math.abs(at.position.z - bt.position.z) - hz);
        if (dx * dx + dy * dy + dz * dz > 1e-6) continue;
      } else if (sph) {
        const r = sph.radius * Math.max(bt.scale.x, bt.scale.y, bt.scale.z);
        const d = Math.hypot(at.position.x - bt.position.x, at.position.y - bt.position.y, at.position.z - bt.position.z);
        if (d > r) continue;
      } else {
        continue;
      }
      const impulse = rb.velocity.length();
      if (impulse < minImpulse) continue;
      out.push({ a, b, impulse });
    }
  }
  return out;
}
