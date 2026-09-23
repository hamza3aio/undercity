import { Vec3 } from "../math/vec3.js";
import { World } from "../ecs/world.js";
import type { MeshRef, Transform } from "../ecs/components.js";

interface SerializedEntity {
  pos: [number, number, number];
  rotY: number;
  scale: [number, number, number];
  mesh?: MeshRef;
  static?: boolean;
}

// Minimal scene serialization: transforms + mesh + static colliders.
export function saveScene(world: World): string {
  const arr: SerializedEntity[] = [];
  for (const e of world.query("transform")) {
    const t = world.get<Transform>(e, "transform")!;
    const mesh = world.get<MeshRef>(e, "mesh");
    const col = world.get<{ isStatic: boolean }>(e, "collider");
    arr.push({
      pos: [t.position.x, t.position.y, t.position.z],
      rotY: t.rotationY,
      scale: [t.scale.x, t.scale.y, t.scale.z],
      mesh: mesh ? { ...mesh } : undefined,
      static: col ? col.isStatic : undefined,
    });
  }
  return JSON.stringify({ version: 1, entities: arr }, null, 2);
}

export function loadScene(world: World, json: string) {
  const data = JSON.parse(json) as { entities: SerializedEntity[] };
  for (const s of data.entities) {
    const e = world.create();
    world.add(e, "transform", {
      position: new Vec3(...s.pos),
      rotationY: s.rotY,
      scale: new Vec3(...s.scale),
    });
    if (s.mesh) world.add(e, "mesh", { ...s.mesh });
    if (s.static !== undefined) {
      world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: s.static });
      world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: !s.static, mass: s.static ? 0 : 1, grounded: s.static });
    }
  }
}
