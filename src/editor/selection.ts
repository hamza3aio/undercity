// Glitch editor selection model (Phase 5) — multi-select, hierarchy
// filtering, rename and duplication. Pure logic (no DOM) so it is fully
// testable; editor/overlay.ts renders it.
//
// Duplication goes through the scene serializer on purpose: a duplicated
// entity is exactly what a save/load round-trip produces, so every
// serializable component comes along and nothing is silently dropped.

import { World, type Entity } from "../ecs/world.js";
import { getChildren, getParent } from "../ecs/hierarchy.js";
import { getUid, makeUid, assignUid } from "../ecs/ids.js";
import { loadEntities, serializeEntity, type SerializedEntity } from "../scene/scene.js";
import { makeTransform, type Transform } from "../ecs/components.js";

/** An ordered set of selected entities with a primary (the focus). */
export class SelectionSet {
  private items = new Set<Entity>();
  private primary: Entity = -1;

  get size(): number {
    return this.items.size;
  }

  get isEmpty(): boolean {
    return this.items.size === 0;
  }

  /** The entity the inspector/gizmo acts on (-1 when nothing is selected). */
  get focus(): Entity {
    return this.primary;
  }

  all(): Entity[] {
    return [...this.items];
  }

  has(e: Entity): boolean {
    return this.items.has(e);
  }

  add(e: Entity, makePrimary = true): void {
    this.items.add(e);
    if (makePrimary) this.primary = e;
  }

  toggle(e: Entity): void {
    if (this.items.has(e)) {
      this.items.delete(e);
      if (this.primary === e) this.primary = [...this.items].pop() ?? -1;
    } else {
      this.add(e);
    }
  }

  /** Replaces the selection. */
  set(list: Entity[]): void {
    this.items = new Set(list);
    this.primary = list.length > 0 ? list[list.length - 1] : -1;
  }

  clear(): void {
    this.items.clear();
    this.primary = -1;
  }

  /** Drops dead entities (after a delete or an undo). */
  prune(world: World): void {
    for (const e of [...this.items]) {
      if (!world.isAlive(e)) this.items.delete(e);
    }
    if (this.primary >= 0 && !world.isAlive(this.primary)) {
      this.primary = [...this.items].pop() ?? -1;
    }
  }

  /** Adds every descendant of everything currently selected. */
  expandToChildren(world: World): void {
    const walk = (e: Entity): void => {
      this.items.add(e);
      for (const c of getChildren(world, e)) walk(c);
    };
    for (const e of [...this.items]) walk(e);
  }
}

export type SelectionModifier = "replace" | "add" | "toggle";

/** Applies a click modifier to a selection. */
export function applyClick(sel: SelectionSet, e: Entity, mod: SelectionModifier): void {
  if (mod === "replace") sel.set([e]);
  else if (mod === "add") sel.add(e);
  else sel.toggle(e);
}

export function modifierOf(event: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): SelectionModifier {
  if (event.shiftKey) return "add";
  if (event.ctrlKey || event.metaKey) return "toggle";
  return "replace";
}

// --- hierarchy + filtering ---

export interface HierarchyRow {
  entity: Entity;
  depth: number;
  label: string;
  kind: string;
}

export function entityLabel(world: World, e: Entity): string {
  const named = world.get<{ value: string }>(e, "name");
  if (named?.value) return named.value;
  if (world.has(e, "actor")) return `actor #${e}`;
  if (world.has(e, "animator")) return `rig #${e}`;
  if (world.has(e, "light")) return `light #${e}`;
  if (world.has(e, "rigidbody")) return `body #${e}`;
  return `#${e}`;
}

export function entityKind(world: World, e: Entity): string {
  if (world.has(e, "actor")) return "actor";
  if (world.has(e, "animator")) return "rig";
  if (world.has(e, "light")) return "light";
  if (world.has(e, "rigidbody")) return "body";
  if (world.has(e, "collider")) return "static";
  if (world.has(e, "trigger")) return "trigger";
  if (world.has(e, "mesh")) return "mesh";
  return "empty";
}

export interface FilterOpts {
  search?: string;
  kind?: string;
  /** Keep descendants of a match visible even if they do not match. */
  keepMatchingBranches?: boolean;
}

/**
 * Builds the visible hierarchy: parent before child, indented by depth. A
 * search keeps the matching entity and (optionally) its descendants, so the
 * tree stays readable instead of collapsing to flat matches.
 */
export function hierarchyRows(world: World, opts: FilterOpts = {}): HierarchyRow[] {
  const search = (opts.search ?? "").trim().toLowerCase();
  const kind = opts.kind ?? "";
  const all = world.query("transform");
  const kids = new Map<Entity, Entity[]>();
  const roots: Entity[] = [];
  for (const e of all) {
    const p = getParent(world, e);
    if (p === null || p === undefined || !world.isAlive(p)) roots.push(e);
    else {
      const list = kids.get(p);
      if (list) list.push(e);
      else kids.set(p, [e]);
    }
  }
  const matches = (e: Entity): boolean => {
    if (kind && entityKind(world, e) !== kind) return false;
    if (!search) return true;
    if (String(e) === search) return true; // by entity id
    if (entityLabel(world, e).toLowerCase().includes(search)) return true;
    const uid = getUid(world, e);
    return uid !== null && uid !== undefined && uid.toLowerCase().includes(search);
  };
  const out: HierarchyRow[] = [];
  const walk = (e: Entity, depth: number, forced: boolean): void => {
    const m = matches(e);
    const show = forced || m;
    if (show) out.push({ entity: e, depth, label: entityLabel(world, e), kind: entityKind(world, e) });
    for (const c of kids.get(e) ?? []) {
      // A match (or an ancestor of one) keeps its subtree visible.
      walk(c, show ? depth + 1 : depth, show || (opts.keepMatchingBranches === true && m));
    }
  };
  for (const r of roots.sort((a, b) => a - b)) walk(r, 0, false);
  return out;
}

// --- rename ---

export const MAX_NAME = 64;

// Control characters (0x00-0x1f and 0x7f) are stripped from names.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function sanitizeName(raw: string): string {
  // Strip control characters, collapse nothing else, then clamp.
  return raw.replace(CONTROL_CHARS, "").trim().slice(0, MAX_NAME);
}

/** Renames an entity. Returns the applied name, or null when rejected. */
export function renameEntity(world: World, e: Entity, raw: string): string | null {
  if (e < 0 || !world.isAlive(e)) return null;
  if (world.has(e, "actorPart")) return null; // parts follow their head
  const name = sanitizeName(raw);
  if (name.length === 0) return null;
  world.add(e, "name", { value: name });
  return name;
}

// --- duplication ---

/** Serializes a subtree (root + descendants) the way saveScene would. */
export function serializeSubtree(world: World, root: Entity): SerializedEntity[] {
  const out: SerializedEntity[] = [];
  const walk = (e: Entity): void => {
    if (world.has(e, "actorPart")) return;
    let uid = getUid(world, e);
    if (!uid) {
      uid = makeUid("dup");
      try {
        assignUid(world, e, uid);
      } catch {
        uid = makeUid("dup2");
        assignUid(world, e, uid);
      }
    }
    const parent = getParent(world, e);
    // Inside the subtree, keep the parent link; outside it, drop it.
    const parentUid = parent === null || parent === undefined ? null : getUid(world, parent) ?? null;
    const s = serializeEntity(world, e, { uid, parentUid });
    if (s) out.push(s);
    for (const c of getChildren(world, e)) walk(c);
  };
  walk(root);
  return out;
}

/**
 * Duplicates a subtree at a world offset with fresh UIDs and correct
 * parent links. Returns the new root, or null when the source cannot be
 * duplicated.
 */
export function duplicateSubtree(
  world: World,
  root: Entity,
  offset: { x: number; y: number; z: number } = { x: 1.5, y: 0, z: 1.5 },
  addTex?: (id: string, img: TexImageSource) => void
): Entity | null {
  if (e0(world, root)) return null;
  const entities = serializeSubtree(world, root);
  if (entities.length === 0) return null;
  // Fresh UIDs, and parent links remapped onto them.
  const remap = new Map<string, string>();
  for (const e of entities) {
    const original = e.uid;
    const fresh = makeUid("copy");
    if (original) remap.set(original, fresh);
    e.uid = fresh;
    e.pos = [e.pos[0] + offset.x, e.pos[1] + offset.y, e.pos[2] + offset.z];
  }
  for (const e of entities) {
    if (e.parentUid) e.parentUid = remap.get(e.parentUid) ?? null;
  }
  const { byUid } = loadEntities(world, entities, { addTex });
  const first = entities[0];
  return first.uid ? byUid.get(first.uid) ?? null : null;
}

/** True when the entity cannot be duplicated (dead id). */
function e0(world: World, e: Entity): boolean {
  return !world.isAlive(e);
}

/** Offsets every entity in a list (multi-select move/duplicate). */
export function offsetEntities(world: World, entities: Entity[], offset: { x: number; y: number; z: number }): number {
  let n = 0;
  for (const e of entities) {
    const t = world.get<Transform>(e, "transform");
    if (!t) continue;
    t.position.set(t.position.x + offset.x, t.position.y + offset.y, t.position.z + offset.z);
    n++;
  }
  return n;
}

/** Returns the entity's transform, adding one if it is missing. */
export function ensureTransform(world: World, e: Entity): Transform | null {
  if (e < 0) return null;
  const t = world.get<Transform>(e, "transform");
  if (t) return t;
  world.add(e, "transform", makeTransform(0, 0, 0));
  return world.get<Transform>(e, "transform") ?? null;
}
