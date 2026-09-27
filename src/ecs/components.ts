import { Vec3 } from "../math/vec3.js";
import type { TerrainMaterial } from "../world/terrain.js";
// Type-only: the LOD level shape lives with the renderer, but entities carry it.
import type { LODLevel } from "../rendering/lod.js";

export interface Transform {
  position: Vec3;
  rotationY: number;
  scale: Vec3;
}

export function makeTransform(x = 0, y = 0, z = 0): Transform {
  return { position: new Vec3(x, y, z), rotationY: 0, scale: new Vec3(1, 1, 1) };
}

export interface Rigidbody {
  velocity: Vec3;
  useGravity: boolean;
  mass: number;
  grounded: boolean;
}

export function makeRigidbody(useGravity = true, mass = 1): Rigidbody {
  return { velocity: new Vec3(), useGravity, mass, grounded: false };
}

export interface BoxCollider {
  halfExtents: Vec3; // local half size (before scale)
  isStatic: boolean;
}

export interface SphereCollider {
  radius: number; // local radius (scaled by max entity scale axis)
  isStatic: boolean;
}

export interface CapsuleCollider {
  radius: number; // local radius (scaled like a sphere)
  height: number; // total height INCLUDING caps, Y axis (scaled by scale.y)
  isStatic: boolean;
}

export interface TerrainCollider {
  size: number; // verts per side (matches Heightmap.size)
  cell: number; // world units between verts
  heights: number[]; // row-major, length size*size, LOCAL to the entity
}

export interface MeshRef {
  meshId: string;
  color: [number, number, number];
  textureId?: string;
  uvScale?: number;
  shininess?: number;
  materialId?: string; // PBR material id; unknown ids fall back to legacy shading
  terrain?: TerrainMaterial; // splat-mapped terrain (takes its own draw path)
  /**
   * Optional LOD chain (Phase 2). When present the renderer draws the level
   * whose screen coverage best matches the entity's distance from the
   * camera. Level 0 should be `meshId` itself or a close variant; unknown
   * mesh ids in a level fall back to `meshId`.
   */
  lod?: LODLevel[];
}

export interface Spin {
  speed: number;
}

export interface PlayerTag {
  speed: number;
  jumpSpeed: number;
}

// --- lights (Phase 3) ---

/**
 * Light component. Position comes from the entity transform; `direction`
 * is local-space (rotating the entity aims the spot) so lights can be
 * parented and animated. `on` lets a game disable a light without
 * removing the component.
 */
export interface Light {
  kind: "point" | "spot";
  color: [number, number, number];
  intensity: number;
  range: number;
  /** Local-space aim for spots (points ignore this). */
  direction: [number, number, number];
  innerAngle: number; // radians
  outerAngle: number; // radians
  on: boolean;
}

export function makeLight(kind: "point" | "spot" = "point"): Light {
  return {
    kind,
    color: [1, 0.9, 0.7],
    intensity: 1,
    range: 20,
    direction: [0, -1, 0],
    innerAngle: (25 * Math.PI) / 180,
    outerAngle: (38 * Math.PI) / 180,
    on: true,
  };
}
