// Glitch scene format v4 — migration, per-entity recovery, additive scenes
// and prefab overrides.
//
// Why v4: v3 still dropped the light, terrain, spin, trigger, rigidbody and
// rigidbody-velocity state, had no migration path, and could only load a
// whole scene at once. v4 keeps the v3 human-readable shape (stable UIDs,
// parent links, 2-space JSON, deterministic output) and adds:
//
//   * migration: v1/v2/v3 payloads upgrade field-by-field, never by guess
//   * recovery: one bad entity is skipped, everything else still loads
//   * additive: loadScene(world, json, { additive: true }) merges into an
//     existing world instead of replacing it
//   * overrides: loadScene(..., { overrides }) patches matching entities
//     by UID after load (prefab instances with per-instance tweaks)
//   * components: light, terrain, spin, trigger, rigidbody + velocity
//
// Files stay Git-friendly: no timestamps, no binary, keys written in a
// fixed order.

import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import type { MeshRef, Transform } from "../ecs/components.js";
import { getParent, setParent } from "../ecs/hierarchy.js";
import { assignUid, findByUid, getUid, makeUid } from "../ecs/ids.js";
import { buildActor, poseActor, type ActorOpts } from "./actor.js";
import type { LODLevel } from "../rendering/lod.js";

export const SCENE_VERSION = 4;

export interface SerializedCollider {
  halfExtents: [number, number, number];
  static: boolean;
}

export interface SerializedLight {
  kind: "point" | "spot";
  color: [number, number, number];
  intensity: number;
  range: number;
  direction: [number, number, number];
  innerAngle: number;
  outerAngle: number;
  on: boolean;
}

export interface SerializedTerrain {
  size: number;
  cell: number;
  heights: number[];
}

export interface SerializedRigidbody {
  velocity: [number, number, number];
  useGravity: boolean;
  mass: number;
}

export interface SerializedTrigger {
  halfExtents: [number, number, number];
}

export interface SerializedEntity {
  uid?: string;
  parentUid?: string | null;
  pos: [number, number, number];
  rotY: number;
  scale: [number, number, number];
  mesh?: MeshRef;
  collider?: SerializedCollider; // v3+: full extents
  static?: boolean; // legacy v1/v2: boolean only, extents default to 0.5
  actor?: ActorOpts; // cartoon rig root (head entity carries this marker)
  light?: SerializedLight; // v4
  terrain?: SerializedTerrain; // v4
  spin?: { speed: number }; // v4
  trigger?: SerializedTrigger; // v4
  rigidbody?: SerializedRigidbody; // v4
  name?: string; // v4: human label for the hierarchy view
}

export interface SceneFile {
  version: number;
  entities: SerializedEntity[];
  name?: string; // v4: optional scene name
}

export interface LoadedStats {
  loaded: number;
  skipped: number;
  migratedFrom: number;
  version: number;
  errors: string[]; // per-entity reasons (bounded)
  additive: boolean;
}

export type UidMapper = (localUid: string) => string;

// --- field helpers (validation at the boundary, never inside the world) ---

function vec3(v: unknown, fallback: Vec3): Vec3 {
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return new Vec3(v[0] as number, v[1] as number, v[2] as number);
  }
  return fallback;
}
function tuple3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [v[0] as number, v[1] as number, v[2] as number];
  }
  return fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Keeps only well-formed LOD levels: a non-empty meshId string and a finite
 * coverage in 0..1 (optionally a cull floor). Anything else is dropped, and
 * a chain with no usable level is dropped entirely.
 */
export function sanitizeLOD(v: unknown): LODLevel[] | null {
  if (!Array.isArray(v)) return null;
  const out: LODLevel[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as Record<string, unknown>;
    if (typeof l.meshId !== "string" || l.meshId.length === 0) continue;
    const coverage = num(l.coverage, -1);
    if (coverage < 0 || coverage > 1) continue;
    const level: LODLevel = { meshId: l.meshId, coverage };
    const cull = num(l.cullBelow, -1);
    if (cull >= 0 && cull <= 1) level.cullBelow = cull;
    out.push(level);
  }
  return out.length > 0 ? out : null;
}

// --- migration ---

/**
 * Upgrades any supported payload to the current in-memory shape. Pure: it
 * never touches a World, so it is fully testable. Throws only on input that
 * is not a scene at all (the caller decides whether to clear or keep).
 */
export function migrateScene(raw: unknown): SceneFile {
  if (typeof raw !== "object" || raw === null) throw new Error("migrateScene: expected an object");
  const data = raw as { version?: unknown; entities?: unknown; name?: unknown };
  if (!Array.isArray(data.entities)) throw new Error("migrateScene: expected { entities: [...] }");
  const from = typeof data.version === "number" && Number.isFinite(data.version) ? data.version : 1;
  if (from > SCENE_VERSION) {
    throw new Error(`migrateScene: file version ${from} is newer than this engine (${SCENE_VERSION})`);
  }
  const entities: SerializedEntity[] = [];
  for (const e of data.entities) entities.push(migrateEntity(e, from));
  const out: SceneFile = { version: SCENE_VERSION, entities };
  if (typeof data.name === "string" && data.name.length > 0) out.name = data.name;
  return out;
}

function migrateEntity(e: unknown, from: number): SerializedEntity {
  if (typeof e !== "object" || e === null) throw new Error("entity is not an object");
  const s = e as Record<string, unknown>;
  const out: SerializedEntity = {
    pos: tuple3(s.pos, [0, 0, 0]),
    rotY: num(s.rotY, 0),
    scale: tuple3(s.scale, [1, 1, 1]),
  };
  if (typeof s.uid === "string" && s.uid.length > 0) out.uid = s.uid;
  if (s.parentUid === null || typeof s.parentUid === "string") out.parentUid = (s.parentUid as string | null) ?? null;
  if (typeof s.mesh === "object" && s.mesh !== null) {
    out.mesh = { ...(s.mesh as MeshRef) };
    // `lod` is validated rather than spread through: a hand-edited file
    // must not be able to inject an arbitrary blob into the render path.
    const lod = sanitizeLOD((s.mesh as Record<string, unknown>).lod);
    if (lod) out.mesh.lod = lod;
    else delete out.mesh.lod;
  }
  if (typeof s.actor === "object" && s.actor !== null) out.actor = s.actor as ActorOpts;
  if (typeof s.name === "string" && s.name.length > 0) out.name = s.name;

  // v1/v2: `static: boolean` only -> synthesize 0.5 extents (the old loader's
  // behaviour) so old files keep their collision volume.
  if (from < 3) {
    if (typeof s.static === "boolean") {
      out.static = s.static;
      out.collider = { halfExtents: [0.5, 0.5, 0.5], static: s.static };
    }
  } else if (typeof s.collider === "object" && s.collider !== null) {
    const c = s.collider as { halfExtents?: unknown; static?: unknown };
    out.collider = {
      halfExtents: tuple3(c.halfExtents, [0.5, 0.5, 0.5]),
      static: bool(c.static, true),
    };
  } else if (typeof s.static === "boolean") {
    out.static = s.static;
    out.collider = { halfExtents: [0.5, 0.5, 0.5], static: s.static };
  }

  // v4 components; ignored (not invented) on older files.
  if (from >= 4) {
    if (typeof s.light === "object" && s.light !== null) {
      const l = s.light as Record<string, unknown>;
      out.light = {
        kind: l.kind === "spot" ? "spot" : "point",
        color: tuple3(l.color, [1, 0.9, 0.7]),
        intensity: num(l.intensity, 1),
        range: num(l.range, 20),
        direction: tuple3(l.direction, [0, -1, 0]),
        innerAngle: num(l.innerAngle, 0.44),
        outerAngle: num(l.outerAngle, 0.66),
        on: bool(l.on, true),
      };
    }
    if (typeof s.terrain === "object" && s.terrain !== null) {
      const t = s.terrain as Record<string, unknown>;
      const size = Math.max(2, Math.round(num(t.size, 0)));
      const cell = Math.max(1e-3, num(t.cell, 1));
      const heights = Array.isArray(t.heights) ? t.heights.filter((h): h is number => typeof h === "number" && Number.isFinite(h)) : [];
      if (size >= 2 && heights.length === size * size) {
        out.terrain = { size, cell, heights };
      }
    }
    if (typeof s.spin === "object" && s.spin !== null) out.spin = { speed: num((s.spin as { speed?: unknown }).speed, 0) };
    if (typeof s.trigger === "object" && s.trigger !== null) {
      out.trigger = { halfExtents: tuple3((s.trigger as { halfExtents?: unknown }).halfExtents, [1, 1, 1]) };
    }
    if (typeof s.rigidbody === "object" && s.rigidbody !== null) {
      const r = s.rigidbody as Record<string, unknown>;
      out.rigidbody = {
        velocity: tuple3(r.velocity, [0, 0, 0]),
        useGravity: bool(r.useGravity, true),
        mass: num(r.mass, 1),
      };
    }
  }
  return out;
}

// --- serialization ---

export function serializeEntity(
  world: World,
  e: Entity,
  over?: { uid?: string; parentUid?: string | null }
): SerializedEntity | null {
  if (world.has(e, "actorPart")) return null;
  const t = world.get<Transform>(e, "transform");
  if (!t) return null;
  const actor = world.get<{ opts: ActorOpts }>(e, "actor");
  const col = world.get<{ halfExtents: Vec3; isStatic: boolean }>(e, "collider");
  const parent = over ? undefined : getParent(world, e);
  const out: SerializedEntity = {
    uid: over?.uid ?? getUid(world, e) ?? undefined,
    parentUid: over
      ? over.parentUid ?? undefined
      : parent == null
        ? undefined
        : getUid(world, parent) ?? undefined,
    pos: [t.position.x, t.position.y, t.position.z],
    rotY: t.rotationY,
    scale: [t.scale.x, t.scale.y, t.scale.z],
  };
  if (actor) out.actor = actor.opts;
  else {
    const m = world.get<MeshRef>(e, "mesh");
    if (m) out.mesh = { ...m };
  }
  if (col) out.collider = { halfExtents: [col.halfExtents.x, col.halfExtents.y, col.halfExtents.z], static: col.isStatic };
  const light = world.get<{ kind: "point" | "spot"; color: [number, number, number]; intensity: number; range: number; direction: [number, number, number]; innerAngle: number; outerAngle: number; on: boolean }>(e, "light");
  if (light) out.light = { ...light, color: [...light.color], direction: [...light.direction] };
  const terr = world.get<{ size: number; cell: number; heights: number[] }>(e, "terrain");
  if (terr) out.terrain = { size: terr.size, cell: terr.cell, heights: [...terr.heights] };
  const spin = world.get<{ speed: number }>(e, "spin");
  if (spin) out.spin = { speed: spin.speed };
  const trig = world.get<{ halfExtents: Vec3 }>(e, "trigger");
  if (trig) out.trigger = { halfExtents: [trig.halfExtents.x, trig.halfExtents.y, trig.halfExtents.z] };
  const rb = world.get<{ velocity: Vec3; useGravity: boolean; mass: number }>(e, "rigidbody");
  if (rb) out.rigidbody = { velocity: [rb.velocity.x, rb.velocity.y, rb.velocity.z], useGravity: rb.useGravity, mass: rb.mass };
  const name = world.get<{ value: string }>(e, "name");
  if (name?.value) out.name = name.value;
  return out;
}

export function saveScene(world: World, name?: string): string {
  const arr: SerializedEntity[] = [];
  for (const e of world.query("transform")) {
    const s = serializeEntity(world, e);
    if (s) arr.push(s);
  }
  const file: SceneFile = { version: SCENE_VERSION, entities: arr };
  if (name) file.name = name;
  return JSON.stringify(file, null, 2);
}

// --- loading ---

export interface LoadOptions {
  addTex?: (id: string, img: TexImageSource) => void;
  uidMapper?: UidMapper;
  /** Per-entity failures are collected here instead of thrown. */
  errors?: string[];
  /** Optional central logger: every skipped entity is also reported there. */
  log?: { error(system: string, message: string, data?: unknown): unknown };
}

/**
 * Creates entities from migrated data. Never throws for a bad entity: the
 * entity is skipped and (optionally) reported. Returns the UID map so
 * callers can resolve references.
 */
export function loadEntities(
  world: World,
  entities: SerializedEntity[],
  opts: LoadOptions = {}
): { loaded: number; skipped: number; byUid: Map<string, Entity> } {
  const { addTex, uidMapper = (u: string) => u, errors } = opts;
  const log = opts.log;
  let loaded = 0;
  let skipped = 0;
  const byUid = new Map<string, Entity>();
  const pendingParents: { e: Entity; parentUid: string }[] = [];
  const note = (msg: string) => {
    if (errors && errors.length < 50) errors.push(msg);
  };
  const fail = (msg: string) => {
    note(msg);
    if (log) log.error("scene", msg);
  };

  for (const s of entities) {
    try {
      if (s.actor) {
        let head: Entity;
        if (addTex) {
          const rig = buildActor(world, addTex, s.actor);
          poseActor(world, rig, s.pos[0], s.pos[1], s.pos[2], s.rotY, 0, false);
          head = rig.head;
        } else {
          // No texture source: gray placeholder rather than silent drop.
          head = world.create();
          world.add(head, "transform", {
            position: new Vec3(...s.pos), rotationY: s.rotY, scale: new Vec3(...s.scale),
          });
          world.add(head, "mesh", { meshId: "cube", color: [0.5, 0.5, 0.55] });
        }
        if (s.uid) {
          try {
            assignUid(world, head, uidMapper(s.uid));
          } catch {
            assignUid(world, head, makeUid("dup"));
          }
          byUid.set(s.uid, head);
        }
        if (s.parentUid) pendingParents.push({ e: head, parentUid: s.parentUid });
        loaded++;
        continue;
      }

      const e = world.create();
      world.add(e, "transform", {
        position: new Vec3(...s.pos), rotationY: s.rotY, scale: new Vec3(...s.scale),
      });
      if (s.mesh) world.add(e, "mesh", { ...s.mesh });
      if (s.collider) {
        world.add(e, "collider", { halfExtents: new Vec3(...s.collider.halfExtents), isStatic: s.collider.static });
      }
      if (s.rigidbody) {
        world.add(e, "rigidbody", {
          velocity: new Vec3(...s.rigidbody.velocity),
          useGravity: s.rigidbody.useGravity,
          mass: s.rigidbody.mass,
          grounded: false,
        });
      } else if (s.collider) {
        // v4 keeps the legacy convenience: a collider implies a rigidbody.
        world.add(e, "rigidbody", {
          velocity: new Vec3(), useGravity: !s.collider.static,
          mass: s.collider.static ? 0 : 1, grounded: s.collider.static,
        });
      }
      if (s.light) world.add(e, "light", { ...s.light, color: [...s.light.color], direction: [...s.light.direction] });
      if (s.terrain) world.add(e, "terrain", { size: s.terrain.size, cell: s.terrain.cell, heights: [...s.terrain.heights] });
      if (s.spin) world.add(e, "spin", { speed: s.spin.speed });
      if (s.trigger) world.add(e, "trigger", { halfExtents: new Vec3(...s.trigger.halfExtents), entered: false });
      if (s.name) world.add(e, "name", { value: s.name });
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
    } catch (err) {
      skipped++;
      fail(`entity ${s?.uid ?? "(no uid)"} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const { e, parentUid } of pendingParents) {
    const p = byUid.get(parentUid) ?? findByUid(world, parentUid);
    if (p !== null && p !== undefined && world.isAlive(p) && world.isAlive(e)) {
      try {
        setParent(world, e, p);
      } catch {
        fail(`parent link ${parentUid} rejected (cycle?)`);
      }
    }
  }
  return { loaded, skipped, byUid };
}

export interface SceneLoadOptions extends LoadOptions {
  /** Keep the existing world contents instead of clearing it first. */
  additive?: boolean;
  /** Per-UID patches applied after load (prefab instance overrides). */
  overrides?: Record<string, Partial<SerializedEntity>>;
}

/** Applies post-load overrides by UID. Unknown UIDs are reported, not fatal. */
export function applyOverrides(
  world: World,
  overrides: Record<string, Partial<SerializedEntity>>,
  errors?: string[]
): number {
  let applied = 0;
  for (const [uid, patch] of Object.entries(overrides)) {
    const e = findByUid(world, uid);
    if (e === null) {
      if (errors && errors.length < 50) errors.push(`override for unknown uid "${uid}"`);
      continue;
    }
    const t = world.get<Transform>(e, "transform");
    if (t) {
      if (patch.pos) t.position = vec3(patch.pos, t.position);
      if (typeof patch.rotY === "number") t.rotationY = patch.rotY;
      if (patch.scale) t.scale = vec3(patch.scale, t.scale);
    }
    if (patch.mesh) world.add<MeshRef>(e, "mesh", { ...patch.mesh });
    if (patch.collider) {
      world.add(e, "collider", { halfExtents: new Vec3(...patch.collider.halfExtents), isStatic: patch.collider.static });
    }
    if (patch.name) world.add(e, "name", { value: patch.name });
    applied++;
  }
  return applied;
}

export function loadScene(
  world: World,
  json: string,
  opts: SceneLoadOptions | ((id: string, img: TexImageSource) => void) = {}
): LoadedStats {
  // Backwards compatible: the v3 signature took addTex as a bare function.
  const o: SceneLoadOptions = typeof opts === "function" ? { addTex: opts } : opts;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`loadScene: malformed JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const errors: string[] = o.errors ?? [];
  let file: SceneFile;
  try {
    file = migrateScene(raw);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const migratedFrom = typeof (raw as { version?: unknown }).version === "number"
    ? ((raw as { version: number }).version)
    : 1;
  const additive = o.additive === true;
  if (!additive) clearScene(world);
  const { loaded, skipped } = loadEntities(world, file.entities, { ...o, errors });
  if (o.overrides) applyOverrides(world, o.overrides, errors);
  return { loaded, skipped, migratedFrom, version: SCENE_VERSION, errors, additive };
}

/** Destroys every entity the scene owns (everything with a transform). */
export function clearScene(world: World): number {
  const list = world.query("transform");
  for (const e of list) {
    if (world.isAlive(e)) world.destroy(e);
  }
  return list.length;
}
