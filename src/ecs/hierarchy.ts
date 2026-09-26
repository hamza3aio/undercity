// Glitch hierarchy — parent/child scene graph over the flat ECS store.
// Convention: component "parent" = { parent: Entity | null }.
// World matrices follow the renderer convention: M = T * RotY * S.
// Physics and renderer still consume world-space transforms directly;
// hierarchy is opt-in (props, rigs, editor trees) until they integrate it.

import { World, type Entity } from "./world.js";
import { Mat4 } from "../math/mat4.js";
import { Vec3 } from "../math/vec3.js";
import type { Transform } from "./components.js";

export const PARENT_COMPONENT = "parent";

export interface ParentLink {
  parent: Entity | null;
}

export function getParent(world: World, e: Entity): Entity | null {
  return world.get<ParentLink>(e, PARENT_COMPONENT)?.parent ?? null;
}

export function isDescendantOf(world: World, e: Entity, ancestor: Entity): boolean {
  let cur = getParent(world, e);
  const seen = new Set<Entity>([e]);
  while (cur !== null) {
    if (cur === ancestor) return true;
    if (seen.has(cur)) return false; // pre-existing cycle: stop, don't hang
    seen.add(cur);
    cur = getParent(world, cur);
  }
  return false;
}

export function setParent(world: World, child: Entity, parent: Entity | null): void {
  if (!world.isAlive(child)) throw new Error(`setParent: child #${child} is not alive`);
  if (parent === null) {
    world.remove(child, PARENT_COMPONENT);
    return;
  }
  if (!world.isAlive(parent)) throw new Error(`setParent: parent #${parent} is not alive`);
  if (parent === child) throw new Error("setParent: entity cannot parent itself");
  if (isDescendantOf(world, parent, child)) {
    throw new Error("setParent: would create a cycle");
  }
  world.add<ParentLink>(child, PARENT_COMPONENT, { parent });
}

export function getChildren(world: World, parent: Entity): Entity[] {
  const out: Entity[] = [];
  for (const e of world.query(PARENT_COMPONENT)) {
    if (world.get<ParentLink>(e, PARENT_COMPONENT)?.parent === parent) out.push(e);
  }
  return out;
}

export function localMatrix(t: Transform): Mat4 {
  return new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
}

const IDENTITY_TRANSFORM: Transform = {
  position: new Vec3(0, 0, 0),
  rotationY: 0,
  scale: new Vec3(1, 1, 1),
};

// Root-to-leaf composition with a guard against malformed cycles.
export function worldMatrix(world: World, e: Entity): Mat4 {
  const chain: Entity[] = [];
  const seen = new Set<Entity>();
  let cur: Entity | null = e;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = getParent(world, cur);
  }
  const out = new Mat4();
  for (let i = chain.length - 1; i >= 0; i--) {
    const t = world.get<Transform>(chain[i], "transform") ?? IDENTITY_TRANSFORM;
    out.multiply(localMatrix(t));
  }
  return out;
}

export function worldPosition(world: World, e: Entity): Vec3 {
  const m = worldMatrix(world, e).elements;
  return new Vec3(m[12], m[13], m[14]);
}

export function destroyTree(world: World, e: Entity): void {
  for (const child of getChildren(world, e)) destroyTree(world, child);
  // A destroyed parent must not leave dangling links (world.destroy drops
  // the child's own component, but other entities may still point at e).
  for (const other of world.query(PARENT_COMPONENT)) {
    if (world.get<ParentLink>(other, PARENT_COMPONENT)?.parent === e) {
      world.remove(other, PARENT_COMPONENT);
    }
  }
  world.destroy(e);
}
