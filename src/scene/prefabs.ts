// Glitch prefabs — reusable spawn stamps with GUIDs.
// A prefab is JSON: { guid, name, version: 1, entities: SerializedEntity[] }.
// Semantics are deliberately stamp-like: entities spawn at their authored
// WORLD transforms (no local-space authoring yet — that needs full rotation
// support, see ENGINE_ARCHITECTURE.md). Instantiating the same prefab twice
// namespaces colliding UIDs so both copies live. Human-readable, Git-friendly.

import { World, type Entity } from "../ecs/world.js";
import { getChildren, getParent } from "../ecs/hierarchy.js";
import { assignUid, getUid } from "../ecs/ids.js";
import {
  SCENE_VERSION, applyOverrides, loadEntities, migrateScene, serializeEntity,
  type SerializedEntity,
} from "./scene.js";

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
  // Prefab payloads are scene-format entities written by v3+ engines, so they
  // migrate at the current version. The `static: boolean` fallback inside
  // migrateEntity still covers hand-written or very old prefab files.
  const migrated = migrateScene({ version: SCENE_VERSION, entities: def.entities });
  return { guid: def.guid, name: def.name, version: 1, entities: migrated.entities };
}

export interface InstantiateOptions {
  addTex?: (id: string, img: TexImageSource) => void;
  /** Per-UID patches applied after spawn (nested prefab overrides). */
  overrides?: Record<string, Partial<SerializedEntity>>;
}

export function instantiatePrefab(
  world: World,
  def: PrefabDef,
  opts: InstantiateOptions | ((id: string, img: TexImageSource) => void) = {}
): PrefabInstance {
  const o: InstantiateOptions = typeof opts === "function" ? { addTex: opts } : opts;
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
  const errors: string[] = [];
  const { byUid } = loadEntities(world, def.entities, { addTex: o.addTex, uidMapper: mapper, errors });
  if (o.overrides) {
    // Overrides address prefab-local UIDs, so resolve them through byUid.
    const localToRuntime = new Map<string, Entity>();
    for (const [local, runtime] of byUid) localToRuntime.set(local, runtime);
    const resolved: Record<string, Partial<SerializedEntity>> = {};
    for (const [local, patch] of Object.entries(o.overrides)) {
      const runtime = localToRuntime.get(local);
      if (runtime === undefined) {
        if (errors.length < 50) errors.push(`prefab "${def.name}": override for unknown local uid "${local}"`);
        continue;
      }
      const uid = world.get<{ uid: string }>(runtime, "uid")?.uid;
      if (uid) resolved[uid] = patch;
    }
    applyOverrides(world, resolved, errors);
  }
  const rootUid = def.entities.length > 0 ? def.entities[0].uid : undefined;
  const root = rootUid !== undefined ? byUid.get(rootUid) : undefined;
  if (root === undefined) throw new Error("parsePrefab: prefab has no entities");
  return { root, byUid };
}
