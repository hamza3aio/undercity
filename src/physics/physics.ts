import { World, type Entity } from "../ecs/world.js";
import type { BoxCollider, CapsuleCollider, Rigidbody, SphereCollider, Transform } from "../ecs/components.js";
import { Vec3 } from "../math/vec3.js";
import { layersCollide } from "./layers.js";
import { sampleHeight } from "../world/terrain.js";
import type { TerrainCollider } from "../ecs/components.js";

export interface CollisionEvent {
  a: Entity;
  b: Entity;
}

// World-space shape snapshot. Rotation is ignored (boxes stay axis-aligned,
// capsules stay Y-aligned, spheres are rotation-proof) — documented limit.
type Shape =
  | { kind: "box"; half: Vec3; isStatic: boolean }
  | { kind: "sphere"; r: number; isStatic: boolean }
  | { kind: "capsule"; r: number; halfH: number; isStatic: boolean };

export interface Contact {
  nx: number;
  ny: number;
  nz: number;
  depth: number;
}

function shapeOf(world: World, e: Entity, t: Transform): Shape | null {
  const box = world.get<BoxCollider>(e, "collider");
  if (box) {
    return {
      kind: "box",
      half: new Vec3(box.halfExtents.x * t.scale.x, box.halfExtents.y * t.scale.y, box.halfExtents.z * t.scale.z),
      isStatic: box.isStatic,
    };
  }
  const sph = world.get<SphereCollider>(e, "sphere");
  if (sph) {
    const s = Math.max(t.scale.x, t.scale.y, t.scale.z);
    return { kind: "sphere", r: Math.max(0, sph.radius * s), isStatic: sph.isStatic };
  }
  const cap = world.get<CapsuleCollider>(e, "capsule");
  if (cap) {
    const r = Math.max(0, cap.radius * Math.max(t.scale.x, t.scale.z));
    const halfH = Math.max(0, cap.height / 2 - cap.radius) * t.scale.y;
    return { kind: "capsule", r, halfH, isStatic: cap.isStatic };
  }
  return null;
}

// Bodies = transform + rigidbody + any one collider shape.
function bodiesWith(world: World, rigid: boolean): Entity[] {
  const out = new Set<Entity>();
  for (const name of ["collider", "sphere", "capsule"]) {
    const q = rigid
      ? world.query("transform", "rigidbody", name)
      : world.query("transform", name);
    for (const e of q) out.add(e);
  }
  return [...out];
}

export class Physics {
  gravity = -18;
  onCollide: ((e: CollisionEvent) => void) | null = null;
  private wasGrounded = new Map<Entity, boolean>();

  step(world: World, dt: number) {
    // Drop per-entity state for destroyed bodies (no leak across sessions).
    for (const e of this.wasGrounded.keys()) {
      if (!world.isAlive(e)) this.wasGrounded.delete(e);
    }
    // Integrate dynamic bodies
    for (const e of bodiesWith(world, true)) {
      const t = world.get<Transform>(e, "transform")!;
      const rb = world.get<Rigidbody>(e, "rigidbody")!;
      const shape = shapeOf(world, e, t);
      if (!shape || shape.isStatic) continue;
      if (rb.useGravity) rb.velocity.y += this.gravity * dt;
      t.position.x += rb.velocity.x * dt;
      t.position.y += rb.velocity.y * dt;
      t.position.z += rb.velocity.z * dt;
      rb.grounded = false;
    }

    const dynamics = bodiesWith(world, true).filter((e) => {
      const s = shapeOf(world, e, world.get<Transform>(e, "transform")!);
      return s !== null && !s.isStatic;
    });
    const statics = bodiesWith(world, false).filter((e) => {
      const s = shapeOf(world, e, world.get<Transform>(e, "transform")!);
      return s !== null && s.isStatic;
    });

    for (const d of dynamics) {
      const dt2 = world.get<Transform>(d, "transform")!;
      const rb = world.get<Rigidbody>(d, "rigidbody")!;
      const ds = shapeOf(world, d, dt2)!;
      for (const s of statics) {
        if (s === d) continue;
        if (!layersCollide(world, d, s)) continue;
        const st = world.get<Transform>(s, "transform")!;
        const ss = shapeOf(world, s, st)!;
        if (this.resolvePair(world, d, dt2, ds, rb, s, st, ss)) {
          this.onCollide?.({ a: d, b: s });
        }
      }
      // Heightfield terrains (support only: snap + grounded, no impact events —
      // those stay exclusive to the y=0 plane so landing semantics don't change)
      this.resolveTerrains(world, d, dt2, ds, rb);
      // Ground plane y=0 (top surface)
      if (this.resolveGround(dt2, ds, rb)) {
        this.onCollide?.({ a: d, b: -1 as unknown as Entity });
      }
      const was = this.wasGrounded.get(d) ?? false;
      if (!was && rb.grounded) this.onCollide?.({ a: d, b: -2 as unknown as Entity });
      this.wasGrounded.set(d, rb.grounded);
    }
  }

  private resolveTerrains(world: World, d: Entity, t: Transform, s: Shape, rb: Rigidbody): void {
    const bottomOffset = s.kind === "box" ? s.half.y : s.kind === "sphere" ? s.r : s.halfH + s.r;
    for (const te of world.query("transform", "terrain")) {
      if (te === d) continue;
      if (!layersCollide(world, d, te)) continue;
      const tt = world.get<Transform>(te, "transform")!;
      const tc = world.get<TerrainCollider>(te, "terrain")!;
      const ext = ((tc.size - 1) * tc.cell) / 2;
      const lx = t.position.x - tt.position.x;
      const lz = t.position.z - tt.position.z;
      if (Math.abs(lx) > ext || Math.abs(lz) > ext) continue;
      const h = sampleHeight({ size: tc.size, cell: tc.cell, heights: tc.heights }, lx, lz) + tt.position.y;
      if (t.position.y - bottomOffset <= h) {
        t.position.y = h + bottomOffset;
        if (rb.velocity.y < 0) rb.velocity.y = 0;
        rb.grounded = true;
      }
    }
  }

  // Returns true on contact. Emits b=-1 here only for hard ground impacts;
  // the landing-edge event (b=-2) is handled by the caller via wasGrounded.
  private resolveGround(t: Transform, s: Shape, rb: Rigidbody): boolean {
    if (s.kind === "box") {
      const halfY = s.half.y;
      if (t.position.y - halfY <= 0) {
        const hard = rb.velocity.y < -3;
        t.position.y = halfY;
        if (rb.velocity.y < 0) rb.velocity.y = 0;
        rb.grounded = true;
        return hard;
      }
      return false;
    }
    if (s.kind === "sphere") {
      if (t.position.y - s.r <= 0) {
        const hard = rb.velocity.y < -3;
        t.position.y = s.r;
        if (rb.velocity.y < 0) rb.velocity.y = 0;
        rb.grounded = true;
        return hard;
      }
      return false;
    }
    const bottom = t.position.y - s.halfH - s.r;
    if (bottom <= 0) {
      const hard = rb.velocity.y < -3;
      t.position.y += -bottom;
      if (rb.velocity.y < 0) rb.velocity.y = 0;
      rb.grounded = true;
      return hard;
    }
    return false;
  }

  private resolvePair(
    world: World, d: Entity, dt: Transform, ds: Shape, rb: Rigidbody,
    s: Entity, st: Transform, ss: Shape
  ): boolean {
    if (ds.kind === "box" && ss.kind === "box") {
      const dc = world.get<BoxCollider>(d, "collider")!;
      const sc = world.get<BoxCollider>(s, "collider")!;
      return this.resolveBoxOnBox(dt, dc, st, sc, rb);
    }
    if (ds.kind === "sphere" && ss.kind === "sphere") {
      const c = this.sphereSphere(dt.position, ds.r, st.position, ss.r);
      if (!c) return false;
      return this.applyContact(dt, rb, c);
    }
    if (ds.kind === "sphere" && ss.kind === "box") {
      const c = this.sphereBox(dt.position, ds.r, st.position, ss.half);
      if (!c) return false;
      return this.applyContact(dt, rb, c);
    }
    if (ds.kind === "box" && ss.kind === "sphere") {
      // Push the box away from the static sphere (mirror of sphere-box).
      const c = this.sphereBox(st.position, ss.r, dt.position, ds.half);
      if (!c) return false;
      c.nx = -c.nx; c.ny = -c.ny; c.nz = -c.nz;
      return this.applyContact(dt, rb, c);
    }
    if (ds.kind === "capsule" && ss.kind === "box") {
      return this.resolveCapsuleBox(dt, ds.r, ds.halfH, st, ss.half, rb);
    }
    if (ds.kind === "box" && ss.kind === "capsule") {
      // Approximate: treat the dynamic box center as a sphere of its
      // half-diagonal against the capsule segment (documented approx).
      const diag = ss.halfH + ss.r;
      const c = this.capsuleSphere(st.position, ss.r, ss.halfH, dt.position, diag);
      if (!c) return false;
      c.nx = -c.nx; c.ny = -c.ny; c.nz = -c.nz;
      return this.applyContact(dt, rb, c);
    }
    if (ds.kind === "capsule" && ss.kind === "sphere") {
      const c = this.capsuleSphere(dt.position, ds.r, ds.halfH, st.position, ss.r);
      if (!c) return false;
      return this.applyContact(dt, rb, c);
    }
    if (ds.kind === "sphere" && ss.kind === "capsule") {
      const c = this.capsuleSphere(st.position, ss.r, ss.halfH, dt.position, ds.r);
      if (!c) return false;
      c.nx = -c.nx; c.ny = -c.ny; c.nz = -c.nz;
      return this.applyContact(dt, rb, c);
    }
    if (ds.kind === "capsule" && ss.kind === "capsule") {
      const c = this.capsuleCapsule(dt.position, ds.r, ds.halfH, st.position, ss.r, ss.halfH);
      if (!c) return false;
      return this.applyContact(dt, rb, c);
    }
    return false;
  }

  private applyContact(t: Transform, rb: Rigidbody, c: Contact): boolean {
    t.position.x += c.nx * c.depth;
    t.position.y += c.ny * c.depth;
    t.position.z += c.nz * c.depth;
    const vn = rb.velocity.x * c.nx + rb.velocity.y * c.ny + rb.velocity.z * c.nz;
    if (vn < 0) {
      rb.velocity.x -= c.nx * vn;
      rb.velocity.y -= c.ny * vn;
      rb.velocity.z -= c.nz * vn;
    }
    const support = c.ny > 0.7;
    if (support) rb.grounded = true;
    return true;
  }

  private sphereSphere(a: Vec3, ra: number, b: Vec3, rb2: number): Contact | null {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= ra + rb2) return null;
    if (dist < 1e-6) return { nx: 0, ny: 1, nz: 0, depth: ra + rb2 };
    return { nx: dx / dist, ny: dy / dist, nz: dz / dist, depth: ra + rb2 - dist };
  }

  private sphereBox(p: Vec3, r: number, bc: Vec3, half: Vec3): Contact | null {
    const cx = Math.max(bc.x - half.x, Math.min(p.x, bc.x + half.x));
    const cy = Math.max(bc.y - half.y, Math.min(p.y, bc.y + half.y));
    const cz = Math.max(bc.z - half.z, Math.min(p.z, bc.z + half.z));
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= r) return null;
    if (dist < 1e-6) {
      // Center inside the box: push along the least-penetration face.
      const px = half.x - Math.abs(p.x - bc.x);
      const py = half.y - Math.abs(p.y - bc.y);
      const pz = half.z - Math.abs(p.z - bc.z);
      if (py <= px && py <= pz) {
        const s = p.y >= bc.y ? 1 : -1;
        return { nx: 0, ny: s, nz: 0, depth: py + r };
      }
      if (px <= pz) {
        const s = p.x >= bc.x ? 1 : -1;
        return { nx: s, ny: 0, nz: 0, depth: px + r };
      }
      const s = p.z >= bc.z ? 1 : -1;
      return { nx: 0, ny: 0, nz: s, depth: pz + r };
    }
    return { nx: dx / dist, ny: dy / dist, nz: dz / dist, depth: r - dist };
  }

  // Closest point on Y-segment (cx, cy±halfH, cz) to point p.
  private segClosest(cx: number, cy: number, cz: number, halfH: number, p: Vec3): Vec3 {
    const y = Math.max(cy - halfH, Math.min(p.y, cy + halfH));
    return new Vec3(cx, y, cz);
  }

  private capsuleSphere(c: Vec3, cr: number, chalfH: number, sp: Vec3, sr: number): Contact | null {
    const q = this.segClosest(c.x, c.y, c.z, chalfH, sp);
    const dx = q.x - sp.x, dy = q.y - sp.y, dz = q.z - sp.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= cr + sr) return null;
    if (dist < 1e-6) return { nx: 0, ny: 1, nz: 0, depth: cr + sr };
    return { nx: dx / dist, ny: dy / dist, nz: dz / dist, depth: cr + sr - dist };
  }

  // 3-sample approximation: test both segment ends + midpoint as spheres
  // against the box, keep the deepest contact. Documented approximation —
  // exact segment-vs-AABB is future work.
  private resolveCapsuleBox(
    dt: Transform, r: number, halfH: number, st: Transform, shalf: Vec3, rb: Rigidbody
  ): boolean {
    let best: Contact | null = null;
    for (const f of [-1, 0, 1]) {
      const p = new Vec3(dt.position.x, dt.position.y + f * halfH, dt.position.z);
      const c = this.sphereBox(p, r, st.position, shalf);
      if (c && (!best || c.depth > best.depth)) best = c;
    }
    if (!best) return false;
    return this.applyContact(dt, rb, best);
  }

  private capsuleCapsule(a: Vec3, ra: number, ha: number, b: Vec3, rb2: number, hb: number): Contact | null {
    // Both segments are Y-parallel, so clamping each toward the other is the
    // exact closest pair (no general segment-segment solver needed).
    const ay = Math.max(a.y - ha, Math.min(b.y, a.y + ha));
    const by = Math.max(b.y - hb, Math.min(ay, b.y + hb));
    const dx = a.x - b.x, dy = ay - by, dz = a.z - b.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= ra + rb2) return null;
    if (dist < 1e-6) return { nx: 0, ny: 1, nz: 0, depth: ra + rb2 };
    return { nx: dx / dist, ny: dy / dist, nz: dz / dist, depth: ra + rb2 - dist };
  }

  private resolveBoxOnBox(
    dyn: Transform, dc: BoxCollider, st: Transform, sc: BoxCollider, rb: Rigidbody
  ): boolean {
    const dMin = this.min(dyn, dc);
    const dMax = this.max(dyn, dc);
    const sMin = this.min(st, sc);
    const sMax = this.max(st, sc);

    const overlapX = Math.min(dMax.x, sMax.x) - Math.max(dMin.x, sMin.x);
    const overlapY = Math.min(dMax.y, sMax.y) - Math.max(dMin.y, sMin.y);
    const overlapZ = Math.min(dMax.z, sMax.z) - Math.max(dMin.z, sMin.z);
    if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return false;

    // Push out along smallest penetration axis
    if (overlapY <= overlapX && overlapY <= overlapZ) {
      if (dyn.position.y > st.position.y) {
        dyn.position.y += overlapY;
        if (rb.velocity.y < 0) rb.velocity.y = 0;
        rb.grounded = true;
      } else {
        dyn.position.y -= overlapY;
        if (rb.velocity.y > 0) rb.velocity.y = 0;
      }
    } else if (overlapX <= overlapZ) {
      dyn.position.x += dyn.position.x > st.position.x ? overlapX : -overlapX;
      rb.velocity.x = 0;
    } else {
      dyn.position.z += dyn.position.z > st.position.z ? overlapZ : -overlapZ;
      rb.velocity.z = 0;
    }
    return true;
  }

  private min(t: Transform, c: BoxCollider) {
    return {
      x: t.position.x - c.halfExtents.x * t.scale.x,
      y: t.position.y - c.halfExtents.y * t.scale.y,
      z: t.position.z - c.halfExtents.z * t.scale.z,
    };
  }

  private max(t: Transform, c: BoxCollider) {
    return {
      x: t.position.x + c.halfExtents.x * t.scale.x,
      y: t.position.y + c.halfExtents.y * t.scale.y,
      z: t.position.z + c.halfExtents.z * t.scale.z,
    };
  }
}
