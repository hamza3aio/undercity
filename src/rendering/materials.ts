// Glitch PBR materials — data model, registry, presets, validation.
// Metallic/roughness workflow (glTF conventions: B=metallic, G=roughness).
// The runtime shader is PBR_FRAG_SRC (shader.ts); pbr.ts holds the CPU
// reference equations the tests pin down. Material *library* persistence
// (saving .glitchmat files) is future asset-DB work; scenes persist the
// entity-side materialId, and missing materials fall back to legacy shading.

import type { MeshRef } from "../ecs/components.js";

export type AlphaMode = "opaque" | "mask" | "blend";

export interface PBRMaterial {
  name: string;
  albedo: [number, number, number];
  albedoMap?: string;
  metallic: number;
  roughness: number;
  metalRoughMap?: string;
  normalMap?: string;
  normalScale: number;
  aoMap?: string;
  aoStrength: number;
  emissive: [number, number, number];
  emissiveIntensity: number;
  emissiveMap?: string;
  opacity: number;
  alphaMode: AlphaMode;
  alphaCutoff: number;
  doubleSided: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function makePBR(name: string, partial: Partial<PBRMaterial> = {}): PBRMaterial {
  return sanitizeMaterial({
    name,
    albedo: [1, 1, 1],
    metallic: 0,
    roughness: 0.6,
    normalScale: 1,
    aoStrength: 1,
    emissive: [0, 0, 0],
    emissiveIntensity: 1,
    opacity: 1,
    alphaMode: "opaque",
    alphaCutoff: 0.5,
    doubleSided: false,
    ...partial,
  });
}

export function sanitizeMaterial(m: PBRMaterial): PBRMaterial {
  m.metallic = clamp01(m.metallic);
  m.roughness = clamp01(m.roughness);
  m.normalScale = Math.max(0, m.normalScale);
  m.aoStrength = Math.max(0, Math.min(2, m.aoStrength));
  m.emissiveIntensity = Math.max(0, m.emissiveIntensity);
  m.opacity = clamp01(m.opacity);
  m.alphaCutoff = clamp01(m.alphaCutoff);
  if (m.alphaMode !== "opaque" && m.alphaMode !== "mask" && m.alphaMode !== "blend") {
    m.alphaMode = "opaque";
  }
  return m;
}

export class MaterialDB {
  private mats = new Map<string, PBRMaterial>();

  register(id: string, mat: PBRMaterial): void {
    this.mats.set(id, sanitizeMaterial(mat));
  }

  get(id: string): PBRMaterial | undefined {
    return this.mats.get(id);
  }

  has(id: string): boolean {
    return this.mats.has(id);
  }

  ids(): string[] {
    return [...this.mats.keys()];
  }

  duplicate(id: string, newId: string): PBRMaterial {
    const src = this.mats.get(id);
    if (!src) throw new Error(`duplicate: unknown material "${id}"`);
    if (this.mats.has(newId)) throw new Error(`duplicate: "${newId}" already exists`);
    const copy: PBRMaterial = {
      ...src,
      albedo: [...src.albedo] as [number, number, number],
      emissive: [...src.emissive] as [number, number, number],
    };
    this.mats.set(newId, copy);
    return copy;
  }

  presets(): void {
    this.register("matte", makePBR("Matte", { roughness: 0.9 }));
    this.register("plastic", makePBR("Plastic", { roughness: 0.35 }));
    this.register("metal", makePBR("Steel", { metallic: 1, roughness: 0.3 }));
    this.register("gold", makePBR("Gold", {
      albedo: [0.83, 0.68, 0.35], metallic: 1, roughness: 0.35,
    }));
    this.register("rubber", makePBR("Rubber", { albedo: [0.15, 0.15, 0.16], roughness: 0.95 }));
    this.register("lamp", makePBR("Lamp", {
      emissive: [1, 0.8, 0.5], emissiveIntensity: 2,
    }));
  }
}

// Renderer routing rule (also the graceful-fallback contract): an entity
// takes the PBR path only when materialId names a registered material.
export function resolveMaterial(
  m: MeshRef,
  db: { get(id: string): PBRMaterial | undefined }
): PBRMaterial | undefined {
  if (!m.materialId) return undefined;
  return db.get(m.materialId);
}
