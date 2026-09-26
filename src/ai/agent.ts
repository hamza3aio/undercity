// Glitch agents — waypoint following + crowd separation over plain data.
// An agent is component "agent" = { path, index, speed, arrive }. Games own
// repathing (call setPath on a timer, on arrival, or when the world changes).

import { World, type Entity } from "../ecs/world.js";
import type { Transform } from "../ecs/components.js";

export const AGENT_COMPONENT = "agent";

export interface Agent {
  path: { x: number; z: number }[];
  index: number;
  speed: number; // world units per second
  arrive: number; // waypoint acceptance radius
}

export function setPath(world: World, e: Entity, path: { x: number; z: number }[], speed: number, arrive = 0.6): void {
  if (!world.isAlive(e)) throw new Error(`setPath: entity #${e} is not alive`);
  world.add<Agent>(e, AGENT_COMPONENT, { path: path.map((p) => ({ x: p.x, z: p.z })), index: 0, speed, arrive });
}

export function clearPath(world: World, e: Entity): void {
  world.remove(e, AGENT_COMPONENT);
}

export function hasArrived(world: World, e: Entity): boolean {
  const a = world.get<Agent>(e, AGENT_COMPONENT);
  if (!a) return true;
  return a.index >= a.path.length;
}

// Advance one agent. Returns "arrived" | "moving" | "idle" (no path).
// Faces movement direction (rotationY) like CharacterController callers do.
export function updateAgent(world: World, e: Entity, dt: number): "arrived" | "moving" | "idle" {
  const a = world.get<Agent>(e, AGENT_COMPONENT);
  const t = world.get<Transform>(e, "transform");
  if (!a || !t) return "idle";
  if (a.index >= a.path.length) return "arrived";
  if (!(dt > 0) || !(a.speed > 0)) return "moving";
  let remaining = a.speed * dt;
  let guard = a.path.length - a.index + 1;
  while (remaining > 0 && a.index < a.path.length && guard-- > 0) {
    const wp = a.path[a.index];
    const dx = wp.x - t.position.x, dz = wp.z - t.position.z;
    const d = Math.hypot(dx, dz);
    if (d <= a.arrive) {
      a.index++;
      continue;
    }
    const step = Math.min(remaining, d);
    t.position.x += (dx / d) * step;
    t.position.z += (dz / d) * step;
    t.rotationY = Math.atan2(dx, dz);
    remaining -= step;
    if (step >= d - 1e-9) a.index++;
  }
  return a.index >= a.path.length ? "arrived" : "moving";
}

// Push agents apart within `radius` (crowd separation). Strength scales the
// positional correction per second; call after updateAgent, before render.
export function separate(world: World, e: Entity, radius: number, strength: number, dt: number): void {
  const t = world.get<Transform>(e, "transform");
  if (!t || !(radius > 0) || !(strength > 0) || !(dt > 0)) return;
  let px = 0, pz = 0, n = 0;
  for (const o of world.query("transform", AGENT_COMPONENT)) {
    if (o === e) continue;
    const ot = world.get<Transform>(o, "transform")!;
    const dx = t.position.x - ot.position.x;
    const dz = t.position.z - ot.position.z;
    const d = Math.hypot(dx, dz);
    if (d < radius && d > 1e-6) {
      const w = (radius - d) / radius;
      px += (dx / d) * w;
      pz += (dz / d) * w;
      n++;
    }
  }
  if (n === 0) return;
  t.position.x += px * strength * dt;
  t.position.z += pz * strength * dt;
}
