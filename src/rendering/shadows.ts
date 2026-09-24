// Glitch shadows — cheap contact blobs (no shadow maps needed).
// A dark flattened quad hugs the ground under an actor, car or crate.
// Opaque dark reads as a shadow at street level; stick it per frame.

import { World, type Entity } from "../ecs/world.js";
import { makeTransform, type MeshRef } from "../ecs/components.js";

export function makeBlob(world: World, size = 1.4, darkness = 0.03): Entity {
  const e = world.create();
  const t = makeTransform(0, -10, 0);
  t.scale.set(size, 0.02, size * 0.85);
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [darkness, darkness, darkness + 0.01] });
  return e;
}

export function stickBlob(world: World, blob: Entity, x: number, groundY: number, z: number) {
  const t = world.get<{ position: { set(x: number, y: number, z: number): void } }>(blob, "transform")!;
  t.position.set(x, groundY + 0.06, z);
}

export function hideBlob(world: World, blob: Entity) {
  const t = world.get<{ position: { set(x: number, y: number, z: number): void } }>(blob, "transform")!;
  t.position.set(0, -10, 0);
}
