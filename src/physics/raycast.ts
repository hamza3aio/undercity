import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import type { BoxCollider, Transform } from "../ecs/components.js";

export interface Ray {
  origin: Vec3;
  direction: Vec3; // normalized
  maxDist: number;
}

export interface RayHit {
  entity: Entity;
  distance: number;
  point: Vec3;
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
  const sy = slab(ray.origin.y, ray.direction.y, min.y, max.y,);
  const sz = slab(ray.origin.z, ray.direction.z, min.z, max.z);
  if (!sx || !sy || !sz) return null;
  const tmin = Math.max(sx[0], sy[0], sz[0]);
  const tmax = Math.min(sx[1], sy[1], sz[1]);
  if (tmax < Math.max(0, tmin) || tmin > ray.maxDist) return null;
  return Math.max(0, tmin);
}

export function raycastScene(world: World, ray: Ray): RayHit | null {
  let best: RayHit | null = null;
  for (const e of world.query("transform", "collider")) {
    const t = world.get<Transform>(e, "transform")!;
    const c = world.get<BoxCollider>(e, "collider")!;
    const d = rayVsBox(ray, t, c);
    if (d === null) continue;
    if (!best || d < best.distance) {
      best = {
        entity: e,
        distance: d,
        point: new Vec3(
          ray.origin.x + ray.direction.x * d,
          ray.origin.y + ray.direction.y * d,
          ray.origin.z + ray.direction.z * d
        ),
      };
    }
  }
  return best;
}
