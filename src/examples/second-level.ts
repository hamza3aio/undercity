import { World } from "../ecs/world.js";
import { createPlatform, createPickup, createTrigger } from "../scene/prefab.js";
import { Vec3 } from "../math/vec3.js";
import { makeTransform, type MeshRef } from "../ecs/components.js";

// Second level data: builds a harder course + a trigger zone. Call from main or standalone.
export function buildSecondLevel(world: World) {
  const g = world.create();
  world.add(g, "transform", makeTransform(0, -0.51, 0));
  world.add<MeshRef>(g, "mesh", { meshId: "ground", color: [0.12, 0.2, 0.32], textureId: "checker", uvScale: 4 });
  world.add(g, "collider", { halfExtents: new Vec3(15, 0.5, 15), isStatic: true });

  createPlatform(world, 0, 0.5, -3, 2, 1, 2, [0.4, 0.5, 0.6]);
  createPlatform(world, 3, 1.5, -6, 2, 1, 2, [0.5, 0.4, 0.3]);
  createPlatform(world, -3, 2.5, -8, 2, 1, 2, [0.3, 0.6, 0.4]);
  createPickup(world, 0, 2, -3);
  createPickup(world, 3, 3, -6);
  createPickup(world, -3, 4, -8);
  createTrigger(world, 0, 1, -8, 2, 2, 2);
}
