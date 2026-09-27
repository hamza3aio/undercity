// UNDERCITY reach checks — can the player actually interact with this?
//
// The prompt used to appear whenever the player stood within a radius of a
// prop, which meant you could be told to "deliver the crate" while standing
// behind a warehouse wall. These helpers use the engine's sphere cast to
// check the line of sight first, so the prompt only appears when the
// interaction is genuinely reachable.

import { Vec3 } from "../../math/vec3.js";
import type { World, Entity } from "../../ecs/world.js";
import type { Transform } from "../../ecs/components.js";
import { sphereCastWorld } from "../../physics/shapes.js";

export interface ReachOptions {
  /** Radius of the cast sphere; roughly the player's shoulder width. */
  radius?: number;
  /** Extra slack at the target end, so a beacon you are hugging still counts. */
  targetSlack?: number;
  /** Entities to ignore (player body, the target itself, its parent rig). */
  ignore?: Entity[];
}

export interface ReachResult {
  reachable: boolean;
  /** Distance to the target (0 when out of range). */
  distance: number;
  /** What is in the way, when reachable is false. -1 for "just too far". */
  blockedBy: Entity;
}

/**
 * Line-of-sight test between two world points, ignoring the pair itself.
 * Uses the engine sphere cast, so it respects collider extents and entity
 * scale rather than comparing raw distances.
 */
export function reachCheck(
  world: World,
  from: Vec3,
  to: Vec3,
  maxDist: number,
  opts: ReachOptions = {}
): ReachResult {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= 1e-4) return { reachable: true, distance: 0, blockedBy: -1 };
  if (dist > maxDist) return { reachable: false, distance: dist, blockedBy: -1 };
  const radius = opts.radius ?? 0.3;
  const slack = opts.targetSlack ?? 0.75;
  // Stop short of the target so its own collider does not count as a blocker.
  const travel = Math.max(0, dist - slack);
  if (travel <= 1e-4) return { reachable: true, distance: dist, blockedBy: -1 };
  const hit = sphereCastWorld(world, {
    origin: from.clone(),
    direction: new Vec3(dx, dy, dz),
    radius,
    maxDist: travel,
    ignore: new Set(opts.ignore ?? []),
  });
  if (hit) return { reachable: false, distance: dist, blockedBy: hit.entity };
  return { reachable: true, distance: dist, blockedBy: -1 };
}

/** Convenience: reach check straight to an entity, using its transform. */
export function reachEntity(
  world: World,
  from: Vec3,
  target: Entity,
  maxDist: number,
  opts: ReachOptions = {}
): ReachResult {
  const t = world.get<Transform>(target, "transform");
  if (!t) return { reachable: false, distance: Infinity, blockedBy: -1 };
  return reachCheck(world, from, t.position, maxDist, {
    ...opts,
    ignore: [...(opts.ignore ?? []), target],
  });
}
