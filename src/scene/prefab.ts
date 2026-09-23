import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import { makeRigidbody, makeTransform, type MeshRef } from "../ecs/components.js";

export function createBox(
  world: World, x: number, y: number, z: number,
  color: [number, number, number],
  opts: { static?: boolean; scale?: Vec3; textureId?: string } = {}
): Entity {
  const e = world.create();
  const t = makeTransform(x, y, z);
  if (opts.scale) t.scale = opts.scale;
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color, textureId: opts.textureId });
  world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: opts.static ?? false });
  world.add(e, "rigidbody", opts.static
    ? { velocity: new Vec3(), useGravity: false, mass: 0, grounded: true }
    : makeRigidbody(true, 1));
  return e;
}

export function createPlatform(world: World, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: [number, number, number]): Entity {
  return createBox(world, x, y, z, color, { static: true, scale: new Vec3(sx, sy, sz), textureId: "checker" });
}

export function createPickup(world: World, x: number, y: number, z: number, color: [number, number, number] = [1, 0.8, 0.2]): Entity {
  const e = world.create();
  const t = makeTransform(x, y, z);
  t.scale.set(0.5, 0.5, 0.5);
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color });
  world.add(e, "spin", { speed: 2.5 });
  return e;
}

export function createTrigger(world: World, x: number, y: number, z: number, hx: number, hy: number, hz: number): Entity {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  world.add(e, "trigger", { halfExtents: new Vec3(hx, hy, hz), entered: false });
  return e;
}
