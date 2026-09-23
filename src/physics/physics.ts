import { World, type Entity } from "../ecs/world.js";
import type { BoxCollider, Rigidbody, Transform } from "../ecs/components.js";

export interface CollisionEvent {
  a: Entity;
  b: Entity;
}

export class Physics {
  gravity = -18;
  onCollide: ((e: CollisionEvent) => void) | null = null;
  private wasGrounded = new Map<Entity, boolean>();

  step(world: World, dt: number) {
    // Integrate dynamic bodies
    for (const e of world.query("transform", "rigidbody", "collider") as Entity[]) {
      const t = world.get<Transform>(e, "transform")!;
      const rb = world.get<Rigidbody>(e, "rigidbody")!;
      const col = world.get<BoxCollider>(e, "collider")!;
      if (col.isStatic) continue;
      if (rb.useGravity) rb.velocity.y += this.gravity * dt;
      t.position.x += rb.velocity.x * dt;
      t.position.y += rb.velocity.y * dt;
      t.position.z += rb.velocity.z * dt;
      rb.grounded = false;
    }

    const dynamics = world.query("transform", "rigidbody", "collider")
      .filter((e) => !world.get<BoxCollider>(e, "collider")!.isStatic);
    const statics = world.query("transform", "collider")
      .filter((e) => world.get<BoxCollider>(e, "collider")!.isStatic);

    for (const d of dynamics) {
      const dt2 = world.get<Transform>(d, "transform")!;
      const rb = world.get<Rigidbody>(d, "rigidbody")!;
      const dc = world.get<BoxCollider>(d, "collider")!;
      for (const s of statics) {
        if (s === d) continue;
        const st = world.get<Transform>(s, "transform")!;
        const sc = world.get<BoxCollider>(s, "collider")!;
        if (this.resolveBoxOnBox(dt2, dc, st, sc, rb)) {
          this.onCollide?.({ a: d, b: s });
        }
      }
      // Ground plane y=0 (top surface)
      const halfY = dc.halfExtents.y * dt2.scale.y;
      if (dt2.position.y - halfY <= 0) {
        if (rb.velocity.y < -3) this.onCollide?.({ a: d, b: -1 as unknown as Entity });
        dt2.position.y = halfY;
        if (rb.velocity.y < 0) rb.velocity.y = 0;
        rb.grounded = true;
      }
      const was = this.wasGrounded.get(d) ?? false;
      if (!was && rb.grounded) this.onCollide?.({ a: d, b: -2 as unknown as Entity });
      this.wasGrounded.set(d, rb.grounded);
    }
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
