// Glitch level-of-detail (LOD) — mesh chain selection by screen coverage.
//
// Pure math, no GL: the renderer asks for a level index and draws the mesh
// that comes back. Selection is based on projected screen height rather
// than raw distance, so a big object keeps detail farther away than a small
// one, which is what makes LOD look right across mixed scales.

import { Vec3 } from "../math/vec3.js";

export interface LODLevel {
  /** Mesh id to draw for this level. */
  meshId: string;
  /**
   * Screen coverage (object radius as a fraction of the viewport height)
   * at which this level stops being used. Descending order: the first level
   * that the object no longer meets is chosen. 0 means "always" (LOD0).
   */
  coverage: number;
  /** Skip drawing entirely below this coverage (-1 disables culling). */
  cullBelow?: number;
}

/** Hysteresis band, in coverage units, that stops LODs from flickering. */
export const DEFAULT_LOD_HYSTERESIS = 0.03;

/**
 * Projected coverage of a bounding sphere: its radius as a fraction of the
 * viewport half-height for a perspective camera.
 *   coverage = radius / (distance * tan(fovY / 2))
 * Clamped to 1 (an object more than half the screen tall). This is the
 * metric Unity/Unreal use for LOD groups, so behaviour is comparable.
 */
export function screenCoverage(radius: number, distance: number, fovY: number): number {
  if (distance <= 1e-4) return 1;
  const denom = distance * Math.tan(fovY * 0.5);
  if (denom <= 1e-8) return 1;
  return Math.max(0, Math.min(1, radius / denom));
}

/** Sort cache, so a chain is only normalized once even in the draw loop. */
const normalized = new WeakMap<object, LODLevel[]>();

/** Sorts levels by descending coverage and drops duplicates. */
export function normalizeChain(levels: LODLevel[]): LODLevel[] {
  const hit = normalized.get(levels);
  if (hit) return hit;
  const sorted = [...levels].sort((a, b) => b.coverage - a.coverage);
  const out: LODLevel[] = [];
  for (const l of sorted) {
    if (!Number.isFinite(l.coverage)) continue;
    if (out.length > 0 && Math.abs(out[out.length - 1].coverage - l.coverage) < 1e-6) continue;
    out.push(l);
  }
  normalized.set(levels, out);
  return out;
}

/** Threshold selection with no hysteresis: coarsest level still met. */
function thresholdLevel(chain: LODLevel[], cov: number): number {
  for (let i = 0; i < chain.length; i++) {
    if (cov >= chain[i].coverage) return i;
  }
  return chain.length - 1;
}

/**
 * Picks a LOD index for a chain.
 *
 * `previous` implements hysteresis. The active level is only left once the
 * coverage has moved past *its own* threshold by `hysteresis`, in whichever
 * direction it went, so an object sitting on a boundary does not swap
 * meshes every frame. With `hysteresis = 0` the result is always the pure
 * threshold answer, whatever `previous` was.
 */
export function selectLOD(
  levels: LODLevel[],
  radius: number,
  distance: number,
  fovY: number,
  previous = -1,
  hysteresis = DEFAULT_LOD_HYSTERESIS
): number {
  const chain = normalizeChain(levels);
  if (chain.length === 0) return -1;
  const cov = screenCoverage(radius, distance, fovY);
  if (previous >= 0 && previous < chain.length) {
    // Level i is used for coverage in [chain[i].coverage, chain[i-1].coverage),
    // so the two boundaries are the neighbouring levels' thresholds.
    const finer = previous > 0 ? chain[previous - 1].coverage : Infinity;
    const coarser = chain[previous].coverage;
    // One level per call at most, clamped to the chain ends.
    if (cov >= finer + hysteresis) return previous - 1;
    if (cov < coarser - hysteresis) return Math.min(chain.length - 1, previous + 1);
    return previous;
  }
  return thresholdLevel(chain, cov);
}

/** True when the chain says the object is too small to bother drawing. */
export function lodCulled(levels: LODLevel[], radius: number, distance: number, fovY: number): boolean {
  let floor = -1;
  for (const l of levels) {
    if (l.cullBelow !== undefined) floor = Math.max(floor, l.cullBelow);
  }
  if (floor < 0) return false;
  return screenCoverage(radius, distance, fovY) < floor;
}

/** Options for an auto-generated chain. */
export interface BuildLODOptions {
  /**
   * Screen coverage thresholds per level, descending. Default
   * [0.6, 0.25, 0.1, 0.04] (LOD0..LOD3).
   */
  coverages?: number[];
  /** Fraction of the base mesh's radius each lower LOD covers. Default 0.5. */
  shrink?: number;
  /** Cull coverage floor, or null for no culling. Default null. */
  cullBelow?: number | null;
  /** Hysteresis for the chain. */
  hysteresis?: number;
}

/** A generated chain plus the per-level radii used to draw it. */
export interface LODChain {
  levels: LODLevel[];
  /** radiusScale[i] is multiplied by the base bounding radius. */
  radiusScale: number[];
  hysteresis: number;
  cullBelow: number | null;
}

/**
 * Builds a chain from mesh ids ordered LOD0 -> LODn, assuming each lower
 * level is a simplified copy. Radii shrink geometrically, which is roughly
 * what a decimation pipeline produces, and gives sane culling bounds.
 */
export function buildLODChain(meshIds: string[], opts: BuildLODOptions = {}): LODChain {
  const coverages = opts.coverages ?? [0.6, 0.25, 0.1, 0.04];
  const shrink = opts.shrink ?? 0.5;
  const levels: LODLevel[] = [];
  const radiusScale: number[] = [];
  const n = Math.max(1, Math.min(meshIds.length, coverages.length));
  for (let i = 0; i < n; i++) {
    const level: LODLevel = { meshId: meshIds[i], coverage: coverages[i] };
    // Only the last level may cull; earlier ones never drop the object.
    if (opts.cullBelow !== undefined && opts.cullBelow !== null && i === n - 1) {
      level.cullBelow = opts.cullBelow;
    }
    levels.push(level);
    radiusScale.push(Math.pow(shrink, i));
  }
  return {
    levels,
    radiusScale,
    hysteresis: opts.hysteresis ?? DEFAULT_LOD_HYSTERESIS,
    cullBelow: opts.cullBelow ?? null,
  };
}

/** Convenience wrapper: distance between two points, no allocation. */
export function distanceTo(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Per-entity LOD state, so hysteresis survives across frames. */
export class LODTracker {
  private last = new Map<number, number>();
  /** Entities whose level changed this frame (for profiling/debug). */
  changed = new Set<number>();

  /**
   * Resolves a chain for an entity. Returns the mesh id to draw, or null
   * when the chain says the object is too small to draw at all.
   */
  resolve(
    entity: number,
    levels: LODLevel[],
    baseRadius: number,
    scale: Vec3,
    camera: Vec3,
    position: Vec3,
    fovY: number,
    hysteresis = DEFAULT_LOD_HYSTERESIS
  ): { meshId: string; radius: number; level: number } | null {
    const dist = distanceTo(camera, position);
    const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    const radius = baseRadius * maxScale;
    if (lodCulled(levels, radius, dist, fovY)) {
      this.last.delete(entity);
      return null;
    }
    const prev = this.last.get(entity) ?? -1;
    const level = selectLOD(levels, radius, dist, fovY, prev, hysteresis);
    if (level < 0) return null;
    if (level !== prev) {
      this.changed.add(entity);
      this.last.set(entity, level);
    }
    const chain = normalizeChain(levels);
    return { meshId: chain[level].meshId, radius, level };
  }

  /** Drops state for an entity that no longer exists. */
  forget(entity: number): void {
    this.last.delete(entity);
  }

  clear(): void {
    this.last.clear();
    this.changed.clear();
  }
}
