// Glitch lights — directional / point / spot types plus the ECS Light
// component. The math here (attenuation, cone falloff, light ranking) is
// pure and testable; the shader mirrors spotAttenuation() in
// SPOT_LIGHT_GLSL (rendering/shader.ts).
//
// Limits, stated rather than hidden: spot/point lights are analytic only
// (no shadow maps for them), and the renderer uploads a fixed 4 slots.

import { Vec3 } from "../math/vec3.js";

export interface DirectionalLight {
  direction: Vec3;
  intensity: number;
}

export interface PointLight {
  position: Vec3;
  color: [number, number, number];
  intensity: number;
  range: number;
}

export interface SpotLight {
  position: Vec3;
  /** Unit vector the cone points along. */
  direction: Vec3;
  color: [number, number, number];
  intensity: number;
  range: number;
  /** Full cone angle in radians. */
  innerAngle: number;
  /** Cutoff angle in radians (>= innerAngle). */
  outerAngle: number;
}

export const MAX_POINT_LIGHTS = 4;

export function makeDirectional(direction = new Vec3(-0.5, -1, -0.3), intensity = 1): DirectionalLight {
  return { direction, intensity };
}

export function makeSpot(opts: {
  position?: Vec3;
  direction?: Vec3;
  color?: [number, number, number];
  intensity?: number;
  range?: number;
  innerDegrees?: number;
  outerDegrees?: number;
} = {}): SpotLight {
  const inner = ((opts.innerDegrees ?? 25) * Math.PI) / 180;
  const outer = ((opts.outerDegrees ?? 38) * Math.PI) / 180;
  return {
    position: opts.position?.clone() ?? new Vec3(0, 3, 0),
    direction: (opts.direction ?? new Vec3(0, -1, 0)).clone().normalize(),
    color: opts.color ?? [1, 0.9, 0.7],
    intensity: opts.intensity ?? 1,
    range: opts.range ?? 20,
    innerAngle: Math.min(inner, outer),
    outerAngle: Math.max(inner, outer),
  };
}

// --- attenuation (shared with the shader) ---

// Inverse-square falloff (unchanged shape) with a smooth range cutoff, so
// a light stops contributing once it is past its range instead of fading
// forever. `d` is distance to the light, `range` the cutoff radius.
export function distanceAttenuation(d: number, range: number): number {
  if (d >= range) return 0;
  const f = d / Math.max(1e-6, range);
  return (1 / (1 + 0.25 * d * d)) * (1 - f * f);
}

// Cone falloff: 1 inside the inner angle, smooth ramp to 0 at the outer
// angle, 0 beyond. `cosTheta` is the cosine between the surface normal and
// the direction to the light.
export function spotAttenuation(cosTheta: number, cosInner: number, cosOuter: number): number {
  if (cosTheta <= cosOuter) return 0;
  if (cosTheta >= cosInner) return 1;
  const span = cosInner - cosOuter;
  if (span <= 1e-6) return 1;
  return (cosTheta - cosOuter) / span;
}

// Cosine of the angle between a cone axis and the direction to the surface.
export function coneCosine(axis: Vec3, toPoint: Vec3): number {
  const len = Math.hypot(toPoint.x, toPoint.y, toPoint.z);
  if (len < 1e-8) return 1;
  const ax = axis.x / Math.max(1e-8, Math.hypot(axis.x, axis.y, axis.z));
  const ay = axis.y / Math.max(1e-8, Math.hypot(axis.x, axis.y, axis.z));
  const az = axis.z / Math.max(1e-8, Math.hypot(axis.x, axis.y, axis.z));
  return (ax * toPoint.x + ay * toPoint.y + az * toPoint.z) / len;
}

export function sanitizeSpot(s: SpotLight): SpotLight {
  const outer = Math.max(0.01, Math.min(Math.PI / 2, s.outerAngle));
  const inner = Math.max(0, Math.min(outer, s.innerAngle));
  return {
    position: s.position,
    direction: s.direction.clone().normalize(),
    color: s.color,
    intensity: Math.max(0, Number.isFinite(s.intensity) ? s.intensity : 0),
    range: Math.max(0.1, Number.isFinite(s.range) ? s.range : 1),
    innerAngle: inner,
    outerAngle: outer,
  };
}

// --- light ranking (why 4 slots, and which 4) ---

export interface RankedLight {
  kind: "point" | "spot";
  index: number; // stable id in the caller's list
  score: number; // brightness at the reference point (higher = keep)
}

/**
 * Picks the N most relevant lights for one reference point (camera target).
 * Ranks by apparent intensity, so a nearby dim light can still beat a
 * far bright one. Deterministic: ties break on index.
 */
export function rankLights(
  lights: (PointLight | SpotLight)[],
  kinds: ("point" | "spot")[],
  reference: Vec3,
  max: number
): RankedLight[] {
  const scored: RankedLight[] = [];
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    const kind = kinds[i] ?? "point";
    const dx = l.position.x - reference.x;
    const dy = l.position.y - reference.y;
    const dz = l.position.z - reference.z;
    const d = Math.hypot(dx, dy, dz);
    let score = l.intensity * distanceAttenuation(d, l.range);
    if (kind === "spot") {
      const cone = coneCosine((l as SpotLight).direction, new Vec3(-dx, -dy, -dz));
      score *= spotAttenuation(cone, Math.cos((l as SpotLight).innerAngle), Math.cos((l as SpotLight).outerAngle));
    }
    if (score > 0) scored.push({ kind, index: i, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.slice(0, Math.max(0, max));
}
