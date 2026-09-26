import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import type { MeshRef, Transform } from "../ecs/components.js";
import { getParent, setParent } from "../ecs/hierarchy.js";
import { assignUid, findByUid, getUid, makeUid } from "../ecs/ids.js";
import { buildActor, poseActor, type ActorOpts } from "./actor.js";

export interface SerializedCollider {
  halfExtents: [number, number, number];
  static: boolean;
}

export interface SerializedEntity {
  uid?: string;
  parentUid?: string | null;
  pos: [number, number, number];
  rotY: number;
  scale: [number, number, number];
  mesh?: MeshRef;
  collider?: SerializedCollider; // v3: full extents (fixes lossy v1/v2)
  static?: boolean; // legacy v1/v2: boolean only, extents default to 0.5
  actor?: ActorOpts; // cartoon rig root (head entity carries this marker)
}

export interface LoadedStats {
  loaded: number;
  skipped: number;
  migratedFrom: number;
}

export type UidMapper = (localUid: string) => string;

// Scene serialization v3: transforms + mesh + full colliders + actors +
// opt-in stable UIDs + parent links. Only entities that already carry a UID
// serialize one (deterministic output). Actor parts are skipped individually;
// the head entity stores the full opts. Returns null for actor parts or
// transform-less entities (callers skip those).
export function serializeEntity(
  world: World,
  e: Entity,
  over?: { uid?: string; parentUid?: string | null }
): SerializedEntity | null {
  if (world.has(e, "actorPart")) return null;
  const t = world.get<Transform>(e, "transform");
  if (!t) return null;
  const actor = world.get<{ opts: ActorOpts; parts: Entity[] }>(e, "actor");
  const col = world.get<{ halfExtents: Vec3; isStatic: boolean }>(e, "collider");
  const parent = over ? undefined : getParent(world, e);
  return {
    uid: over?.uid ?? getUid(world, e) ?? undefined,
    parentUid: over
      ? over.parentUid ?? undefined
      : parent == null
        ? undefined
        : getUid(world, parent) ?? undefined,
    pos: [t.position.x, t.position.y, t.position.z],
    rotY: t.rotationY,
    scale: [t.scale.x, t.scale.y, t.scale.z],
    mesh: actor ? undefined : world.get<MeshRef>(e, "mesh") ? { ...world.get<MeshRef>(e, "mesh")! } : undefined,
    collider: col
      ? { halfExtents: [col.halfExtents.x, col.halfExtents.y, col.halfExtents.z], static: col.isStatic }
      : undefined,
    actor: actor ? actor.opts : undefined,
  };
}

export function saveScene(world: World): string {
  const arr: SerializedEntity[] = [];
  for (const e of world.query("transform")) {
    const s = serializeEntity(world, e);
    if (s) arr.push(s);
  }
  return JSON.stringify({ version: 3, entities: arr }, null, 2);
}

// Shared loader core: two passes (create, then link parents). uidMapper
// lets prefabs namespace UIDs on instantiation; scenes pass identity.
export function loadEntities(
  world: World,
  entities: SerializedEntity[],
  addTex: ((id: string, img: TexImageSource) => void) | undefined,
  uidMapper: UidMapper = (u) => u
): { loaded: number; skipped: number; byUid: Map<string, Entity> } {
  let loaded = 0;
  let skipped = 0;
  const byUid = new Map<string, Entity>();
  const pendingParents: { e: Entity; parentUid: string }[] = [];

  for (const s of entities) {
    try {
      if (s.actor) {
        if (addTex) {
          const rig = buildActor(world, addTex, s.actor);
          poseActor(world, rig, s.pos[0], s.pos[1], s.pos[2], s.rotY, 0, false);
          if (s.uid) {
            // Collision (e.g. additive double-load): mint a fresh UID so the
            // entity still loads instead of being skipped.
            try {
              assignUid(world, rig.head, uidMapper(s.uid));
            } catch {
              assignUid(world, rig.head, makeUid("dup"));
            }
            byUid.set(s.uid, rig.head);
          }
        } else {
          // No texture source: gray placeholder rather than silent drop.
          const e = world.create();
          world.add(e, "transform", {
            position: new Vec3(...s.pos),
            rotationY: s.rotY,
            scale: new Vec3(...s.scale),
          });
          world.add(e, "mesh", { meshId: "cube", color: [0.5, 0.5, 0.55] });
          if (s.uid) {
            assignUid(world, e, uidMapper(s.uid));
            byUid.set(s.uid, e);
          }
        }
        loaded++;
        continue;
      }
      const e = world.create();
      world.add(e, "transform", {
        position: new Vec3(...s.pos),
        rotationY: s.rotY,
        scale: new Vec3(...s.scale),
      });
      if (s.mesh) world.add(e, "mesh", { ...s.mesh });
      const col = s.collider ?? (s.static !== undefined
        ? { halfExtents: [0.5, 0.5, 0.5] as [number, number, number], static: s.static }
        : undefined);
      if (col) {
        world.add(e, "collider", {
          halfExtents: new Vec3(...col.halfExtents),
          isStatic: col.static,
        });
        world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: !col.static, mass: col.static ? 0 : 1, grounded: col.static });
      }
      if (s.uid) {
        try {
          assignUid(world, e, uidMapper(s.uid));
        } catch {
          assignUid(world, e, makeUid("dup"));
        }
        byUid.set(s.uid, e);
      }
      if (s.parentUid) pendingParents.push({ e, parentUid: s.parentUid });
      loaded++;
    } catch {
      skipped++;
    }
  }

  for (const { e, parentUid } of pendingParents) {
    const p = byUid.get(parentUid) ?? findByUid(world, parentUid);
    if (p !== null && p !== undefined && world.isAlive(p) && world.isAlive(e)) {
      try {
        setParent(world, e, p);
      } catch {
        // Malformed link (e.g. cycle in file): leave unparented, keep entity.
      }
    }
  }
  return { loaded, skipped, byUid };
}

export function loadScene(
  world: World,
  json: string,
  addTex?: (id: string, img: TexImageSource) => void
): LoadedStats {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`loadScene: malformed JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { entities?: unknown }).entities)) {
    throw new Error("loadScene: expected { entities: [...] }");
  }
  const data = raw as { version?: unknown; entities: SerializedEntity[] };
  const migratedFrom = typeof data.version === "number" ? data.version : 1;
  const { loaded, skipped } = loadEntities(world, data.entities, addTex);
  return { loaded, skipped, migratedFrom };
}
