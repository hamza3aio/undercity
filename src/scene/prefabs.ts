// Glitch prefabs — reusable spawn stamps with GUIDs.
// A prefab is JSON: { guid, name, version: 1, entities: SerializedEntity[] }.
// Semantics are deliberately stamp-like: entities spawn at their authored
// WORLD transforms (no local-space authoring yet — that needs full rotation
// support, see ENGINE_ARCHITECTURE.md). Instantiating the same prefab twice
// namespaces colliding UIDs so both copies live. Human-readable, Git-friendly.

import { World, type Entity } from "../ecs/world.js";
import { getChildren, getParent } from "../ecs/hierarchy.js";
import { assignUid, getUid } from "../ecs/ids.js";
import { loadEntities, serializeEntity, type SerializedEntity } from "./scene.js";

export interface PrefabDef {
  guid: string;
  name: string;
  version: 1;
  entities: SerializedEntity[];
}

export interface PrefabInstance {
  root: Entity;
  byUid: Map<string, Entity>; // prefab-local uid -> runtime entity
}

let guidCounter = 0;

export function makeGuid(prefix = "prefab"): string {
  guidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${guidCounter.toString(36)}`;
}

function subtree(world: World, root: Entity): Entity[] {
  const out: Entity[] = [root];
  for (const c of getChildren(world, root)) out.push(...subtree(world, c));
  return out;
}

// Serialize root + descendants. Entities without UIDs are assigned stable
// `part-N` ones so re-saving the same subtree is deterministic.
export function savePrefab(world: World, root: Entity, name: string, guid: string = makeGuid()): string {
  if (!world.isAlive(root)) throw new Error("savePrefab: root is not alive");
  const members = subtree(world, root);
  const memberSet = new Set(members);
  const entities: SerializedEntity[] = [];
  let part = 0;
  for (const e of members) {
    if (world.has(e, "actorPart")) continue;
    let uid = getUid(world, e);
    if (!uid) {
      uid = `part-${part++}`;
      assignUid(world, e, uid);
    }
    const parent = getParent(world, e);
    const s = serializeEntity(world, e, {
      uid,
      parentUid: parent !== null && memberSet.has(parent) ? getUid(world, parent) : null,
    });
    if (s) entities.push(s);
  }
  const def: PrefabDef = { guid, name, version: 1, entities };
  return JSON.stringify(def, null, 2);
}

export function parsePrefab(json: string): PrefabDef {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`parsePrefab: malformed JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("parsePrefab: expected an object");
  const def = raw as Partial<PrefabDef>;
  if (typeof def.guid !== "string" || def.guid.length === 0) throw new Error("parsePrefab: missing guid");
  if (typeof def.name !== "string") throw new Error("parsePrefab: missing name");
  if (!Array.isArray(def.entities)) throw new Error("parsePrefab: missing entities[]");
  return { guid: def.guid, name: def.name, version: 1, entities: def.entities as SerializedEntity[] };
}

export function instantiatePrefab(
  world: World,
  def: PrefabDef,
  addTex?: (id: string, img: TexImageSource) => void
): PrefabInstance {
  // Namespace UIDs that are already taken so the same prefab (or scene)
  // can be instantiated repeatedly into one world.
  let n = 0;
  const mapped = new Set<string>();
  const mapper = (local: string): string => {
    const taken =
      mapped.has(local) ||
      world.query("uid").some((e) => world.get<{ uid: string }>(e, "uid")?.uid === local);
    if (!taken) {
      mapped.add(local);
      return local;
    }
    n += 1;
    const namespaced = `${def.guid}#${n}:${local}`;
    mapped.add(namespaced);
    return namespaced;
  };
  const { byUid } = loadEntities(world, def.entities, addTex, mapper);
  const rootUid = def.entities.length > 0 ? def.entities[0].uid : undefined;
  const root = rootUid !== undefined ? byUid.get(rootUid) : undefined;
  if (root === undefined) throw new Error("parsePrefab: prefab has no entities");
  return { root, byUid };
}
