// Glitch PBR reference — CPU mirror of PBR_FRAG_SRC's direct-lighting model
// (Cook-Torrance GGX + Schlick Fresnel + Smith geometry, Blinn-Phong-style
// ambient excluded here). Exists so tests pin the equations: the GLSL must
// implement THESE formulas. Differences from the shader are documented:
// the shader multiplies direct light by PI for visual parity with the legacy
// path at intensity 1.0; this reference does not.

import { Vec3 } from "../math/vec3.js";

const PI = Math.PI;
const EPS = 1e-4;

function mixF(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface PBREval {
  diffuse: [number, number, number];
  specular: [number, number, number];
}

export function evalPBR(
  albedo: [number, number, number],
  metallic: number,
  roughness: number,
  n: Vec3,
  v: Vec3,
  lightDirToLight: Vec3,
  lightColor: [number, number, number]
): PBREval {
  const N = n.clone().normalize();
  const V = v.clone().normalize();
  const L = lightDirToLight.clone().normalize();
  const NdotL = Math.max(N.dot(L), 0);
  if (NdotL <= 0) return { diffuse: [0, 0, 0], specular: [0, 0, 0] };
  const NdotV = Math.max(N.dot(V), 0);
  const H = V.clone().add(L).normalize();
  const NdotH = Math.max(N.dot(H), 0);
  const VdotH = Math.max(V.dot(H), 0);

  const a = roughness * roughness;
  const a2 = a * a;
  const denom = NdotH * NdotH * (a2 - 1) + 1;
  // Small epsilon: mirrors keep a strong but finite peak (a perfect spike is
  // unrepresentable in a single rasterized sample anyway).
  const D = a2 / (PI * denom * denom + 1e-7);

  const F0 = albedo.map((c) => mixF(0.04, c, metallic));
  const Frit = VdotH;
  const F = F0.map((f) => f + (1 - f) * Math.pow(1 - Frit, 5));

  const k = ((roughness + 1) * (roughness + 1)) / 8;
  const G =
    (NdotL / (NdotL * (1 - k) + k + EPS)) *
    (NdotV / (NdotV * (1 - k) + k + EPS));

  const diff: [number, number, number] = [0, 0, 0];
  const spec: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const kd = (1 - F[i]) * (1 - metallic);
    diff[i] = ((kd * albedo[i]) / PI) * NdotL * lightColor[i];
    spec[i] = ((D * F[i] * G) / Math.max(4 * NdotV * NdotL, EPS)) * NdotL * lightColor[i];
  }
  return { diffuse: diff, specular: spec };
}
