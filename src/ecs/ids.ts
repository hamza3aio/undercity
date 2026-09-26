// Glitch stable IDs — opt-in persistent string UIDs over numeric entities.
// Convention: component "uid" = { uid: string }. Numeric Entity handles stay
// fast and local; UIDs are for save files, prefabs, editor references and
// (later) network IDs. UID assignment is OPT-IN so saves stay minimal and
// deterministic: only entities that already carry one serialize it.

import { World, type Entity } from "./world.js";

export const UID_COMPONENT = "uid";

export interface Uid {
  uid: string;
}

let counter = 0;

export function makeUid(prefix = "e"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function assignUid(world: World, e: Entity, uid: string = makeUid()): string {
  if (!world.isAlive(e)) throw new Error(`assignUid: entity #${e} is not alive`);
  const existing = world.get<Uid>(e, UID_COMPONENT)?.uid;
  if (existing === uid) return uid; // idempotent
  const holder = findByUid(world, uid);
  if (holder !== null && holder !== e) {
    throw new Error(`assignUid: "${uid}" already belongs to entity #${holder}`);
  }
  world.add<Uid>(e, UID_COMPONENT, { uid });
  return uid;
}

export function getUid(world: World, e: Entity): string | null {
  return world.get<Uid>(e, UID_COMPONENT)?.uid ?? null;
}

// Linear scan — documented cost; an index lands when profiling demands it.
export function findByUid(world: World, uid: string): Entity | null {
  for (const e of world.query(UID_COMPONENT)) {
    if (world.get<Uid>(e, UID_COMPONENT)?.uid === uid) return e;
  }
  return null;
}
