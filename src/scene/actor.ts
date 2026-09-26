// Glitch actors — cartoonish articulated characters from primitives.
// Faces are original procedural canvas paintings (see proctex). A rig is 7
// entities (head/face, hair, torso, 2 arms, 2 legs); poseActor() places and
// walk-animates them from a root position + facing. No rotation math needed
// beyond facing yaw, so it works with the base Transform.

import { World, type Entity } from "../ecs/world.js";
import { Vec3 } from "../math/vec3.js";
import { makeTransform, type MeshRef } from "../ecs/components.js";
import { paintFace, paintShirt, type C3, type FaceOpts } from "../rendering/proctex.js";

export interface ActorOpts {
  skin: C3;
  shirt: C3;
  trim: C3;
  pants: C3;
  hair: C3 | null; // null = bald
  face: Omit<FaceOpts, "skin">;
  tag: string; // texture id prefix (must be unique per actor)
}

export interface ActorRig {
  head: Entity; hair: Entity | null; torso: Entity;
  armL: Entity; armR: Entity; legL: Entity; legR: Entity;
  base: Map<Entity, { x: number; y: number; z: number }>;
}

function part(world: World, rig: ActorRig, key: keyof Omit<ActorRig, "base">, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: C3, textureId?: string): Entity {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color, textureId });
  const t = world.get<{ scale: Vec3 }>(e, "transform")!;
  t.scale.set(sx, sy, sz);
  rig.base.set(e, { x, y, z });
  (rig as unknown as Record<string, Entity | null>)[key] = e;
  return e;
}

export function buildActor(
  world: World,
  addTex: (id: string, img: TexImageSource) => void,
  o: ActorOpts
): ActorRig {
  const rig = { base: new Map() } as ActorRig;
  const faceId = `${o.tag}-face`;
  const shirtId = `${o.tag}-shirt`;
  addTex(faceId, paintFace({ skin: o.skin, ...o.face }));
  addTex(shirtId, paintShirt(o.shirt, o.trim));
  part(world, rig, "legL", -0.15, 0.375, 0, 0.22, 0.75, 0.24, o.pants);
  part(world, rig, "legR", 0.15, 0.375, 0, 0.22, 0.75, 0.24, o.pants);
  part(world, rig, "torso", 0, 1.125, 0, 0.7, 0.75, 0.4, o.shirt, shirtId);
  part(world, rig, "armL", -0.47, 1.0, 0, 0.2, 0.7, 0.2, o.shirt);
  part(world, rig, "armR", 0.47, 1.0, 0, 0.2, 0.7, 0.2, o.shirt);
  part(world, rig, "head", 0, 1.75, 0, 0.5, 0.5, 0.5, o.skin, faceId);
  if (o.hair) {
    part(world, rig, "hair", 0, 2.03, -0.03, 0.56, 0.2, 0.56, o.hair);
    // back panel so the back of the head reads as hair
    const back = world.create();
    world.add(back, "transform", makeTransform(0, 1.85, -0.26));
    world.add<MeshRef>(back, "mesh", { meshId: "cube", color: o.hair });
    const bt = world.get<{ scale: Vec3 }>(back, "transform")!;
    bt.scale.set(0.56, 0.45, 0.1);
    rig.base.set(back, { x: 0, y: 1.85, z: -0.26 });
    (rig as { hairBack?: Entity }).hairBack = back;
  } else {
    rig.hair = null;
  }
  // Rig identity for scene serialization: head carries the full opts,
  // parts are skipped individually by saveScene(). Head itself is NOT a part.
  const parts: Entity[] = [rig.torso, rig.armL, rig.armR, rig.legL, rig.legR];
  if (rig.hair) parts.push(rig.hair);
  const hb = (rig as { hairBack?: Entity }).hairBack;
  if (hb !== undefined) parts.push(hb);
  for (const p of parts) world.add(p, "actorPart", true);
  world.add(rig.head, "actor", { opts: o, parts });
  // place at origin facing +z
  poseActor(world, rig, 0, 0, 0, 0, 0, false);
  return rig;
}

// Position + walk-cycle the rig. phase advances with distance walked.
export function poseActor(
  world: World, rig: ActorRig,
  x: number, y: number, z: number, ry: number,
  phase: number, moving: boolean
) {
  const swing = moving ? Math.sin(phase) * 0.26 : 0;
  const bob = moving ? Math.abs(Math.cos(phase)) * 0.06 : Math.sin(phase * 0.4) * 0.015;
  const c = Math.cos(ry), s = Math.sin(ry);
  const put = (e: Entity | null | undefined, dx: number, dy: number, dz: number) => {
    if (e == null) return;
    const base = rig.base.get(e);
    if (!base) return;
    const lx = base.x + dx, ly = base.y + dy, lz = base.z + dz;
    const t = world.get<{ position: Vec3; rotationY: number }>(e, "transform")!;
    // rotateY convention matches Mat4.rotateY
    t.position.set(x + lx * c + lz * s, y + ly, z - lx * s + lz * c);
    t.rotationY = ry;
  };
  put(rig.legL, 0, 0, swing);
  put(rig.legR, 0, 0, -swing);
  put(rig.armL, 0, 0, -swing * 0.8);
  put(rig.armR, 0, 0, swing * 0.8);
  put(rig.torso, 0, bob, 0);
  put(rig.head, 0, bob * 1.4, 0);
  put(rig.hair, 0, bob * 1.4, 0);
  put((rig as { hairBack?: Entity }).hairBack, 0, bob * 1.4, 0);
}

// Hide/show every part (e.g. first-person mode swaps to the "hidden" mesh).
export function setRigMesh(world: World, rig: ActorRig, meshId: string, prev: Map<Entity, string>) {
  const all: (Entity | null | undefined)[] = [rig.head, rig.hair, rig.torso, rig.armL, rig.armR, rig.legL, rig.legR, (rig as { hairBack?: Entity }).hairBack];
  for (const e of all) {
    if (e == null) continue;
    const m = world.get<MeshRef>(e, "mesh");
    if (!m) continue;
    if (!prev.has(e)) prev.set(e, m.meshId);
    m.meshId = meshId;
  }
}

export function restoreRigMesh(world: World, prev: Map<Entity, string>) {
  for (const [e, id] of prev) {
    const m = world.get<MeshRef>(e, "mesh");
    if (m) m.meshId = id;
  }
  prev.clear();
}
