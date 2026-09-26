export const VERT_SRC = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProj;
uniform float uUVScale;
out vec3 vNormal;
out vec3 vWorldPos;
out vec2 vUV;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorldPos = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV * uUVScale;
  gl_Position = uProj * uView * w;
}`;

export const FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec2 vUV;
uniform vec3 uColor;
uniform vec3 uLightDir;
uniform float uLightIntensity;
uniform vec3 uCamPos;
uniform float uShininess;
uniform sampler2D uMap;
uniform int uUseTexture;
uniform int uPointCount;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(-uLightDir);
  float diff = max(dot(n, l), 0.0) * uLightIntensity;
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  vec3 h = normalize(l + viewDir);
  float spec = pow(max(dot(n, h), 0.0), uShininess) * 0.3;
  vec3 ambient = vec3(0.25);
  vec3 albedo = uColor;
  if (uUseTexture == 1) {
    albedo *= texture(uMap, vUV).rgb;
  }
  vec3 col = albedo * (ambient + diff * 0.9);
  // point lights (diffuse only, distance attenuated)
  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 toL = uPointPos[i] - vWorldPos;
    float d = length(toL);
    float att = 1.0 / (1.0 + 0.25 * d * d);
    float pd = max(dot(n, normalize(toL)), 0.0) * att;
    col += albedo * uPointColor[i] * pd;
  }
  col += vec3(spec);
  float fd = length(vWorldPos - uCamPos);
  float f = smoothstep(uFogNear, uFogFar, fd);
  col = mix(col, uFogColor, f);
  outColor = vec4(col, 1.0);
}`;

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("Shader compile failed: " + gl.getShaderInfoLog(s));
  }
  return s;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("Program link failed: " + gl.getProgramInfoLog(p));
  }
  return p;
}// Instanced variant: same lighting/fog as FRAG_SRC, but model matrix, color
// and (uvScale, shininess) arrive per instance. Kept as a separate pair (not
// a #define maze) so the proven single-draw path is byte-for-byte untouched.
export const INST_VERT_SRC = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in mat4 aIModel;
layout(location=7) in vec3 aIColor;
layout(location=8) in vec2 aIParams;
uniform mat4 uView;
uniform mat4 uProj;
out vec3 vNormal;
out vec3 vWorldPos;
out vec2 vUV;
out vec3 vColor;
out float vShininess;
void main() {
  vec4 w = aIModel * vec4(aPos, 1.0);
  vWorldPos = w.xyz;
  vNormal = mat3(aIModel) * aNormal;
  vUV = aUV * aIParams.x;
  vColor = aIColor;
  vShininess = aIParams.y;
  gl_Position = uProj * uView * w;
}`;

export const INST_FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec2 vUV;
in vec3 vColor;
in float vShininess;
uniform vec3 uLightDir;
uniform float uLightIntensity;
uniform vec3 uCamPos;
uniform sampler2D uMap;
uniform int uUseTexture;
uniform int uPointCount;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(-uLightDir);
  float diff = max(dot(n, l), 0.0) * uLightIntensity;
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  vec3 h = normalize(l + viewDir);
  float spec = pow(max(dot(n, h), 0.0), vShininess) * 0.3;
  vec3 ambient = vec3(0.25);
  vec3 albedo = vColor;
  if (uUseTexture == 1) {
    albedo *= texture(uMap, vUV).rgb;
  }
  vec3 col = albedo * (ambient + diff * 0.9);
  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 toL = uPointPos[i] - vWorldPos;
    float d = length(toL);
    float att = 1.0 / (1.0 + 0.25 * d * d);
    float pd = max(dot(n, normalize(toL)), 0.0) * att;
    col += albedo * uPointColor[i] * pd;
  }
  col += vec3(spec);
  float fd = length(vWorldPos - uCamPos);
  float f = smoothstep(uFogNear, uFogFar, fd);
  col = mix(col, uFogColor, f);
  outColor = vec4(col, 1.0);
}`;

// PBR direct-lighting fragment (Cook-Torrance GGX + Schlick + Smith).
// Equations mirror evalPBR() in pbr.ts, except direct light is multiplied
// by PI so intensity 1.0 matches the legacy path's brightness. No IBL/env
// maps yet: metals pick up the analytic sky-gradient ambient instead.
// Shares VERT_SRC (vNormal/vWorldPos/vUV varyings).
export const PBR_FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec2 vUV;
uniform vec3 uAlbedo;
uniform float uMetallic;
uniform float uRoughness;
uniform sampler2D uAlbedoMap;
uniform sampler2D uMetalRoughMap;
uniform sampler2D uNormalMap;
uniform sampler2D uAOMap;
uniform sampler2D uEmissiveMap;
uniform int uUseAlbedoMap;
uniform int uUseMetalRough;
uniform int uUseNormalMap;
uniform int uUseAO;
uniform int uUseEmissiveMap;
uniform float uNormalScale;
uniform float uAOStrength;
uniform vec3 uEmissive;
uniform float uEmissiveIntensity;
uniform float uOpacity;
uniform int uAlphaMode;
uniform float uAlphaCutoff;
uniform vec3 uLightDir;
uniform float uLightIntensity;
uniform vec3 uCamPos;
uniform int uPointCount;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbientStrength;
out vec4 outColor;

vec3 perturbNormal(vec3 N, vec3 V) {
  vec3 q0 = dFdx(vWorldPos);
  vec3 q1 = dFdy(vWorldPos);
  vec2 st0 = dFdx(vUV);
  vec2 st1 = dFdy(vUV);
  vec3 S = normalize(q0 * st1.t - q1 * st0.t + vec3(1e-6));
  vec3 T = normalize(-q0 * st1.s + q1 * st0.s + vec3(1e-6));
  vec3 mapN = texture(uNormalMap, vUV).rgb * 2.0 - 1.0;
  return normalize(S * mapN.x * uNormalScale + T * mapN.y * uNormalScale + N * mapN.z);
}

vec3 brdf(vec3 albedo, float metallic, float roughness, vec3 N, vec3 V, vec3 L, vec3 lightColor) {
  vec3 H = normalize(V + L);
  float NdotL = max(dot(N, L), 0.0);
  if (NdotL <= 0.0) return vec3(0.0);
  float NdotV = max(dot(N, V), 0.0);
  float NdotH = max(dot(N, H), 0.0);
  float VdotH = max(dot(V, H), 0.0);
  float a = roughness * roughness;
  float a2 = a * a;
  float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * denom * denom + 1e-7);
  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
  float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  float G = (NdotL / (NdotL * (1.0 - k) + k + 1e-4)) * (NdotV / (NdotV * (1.0 - k) + k + 1e-4));
  vec3 kd = (1.0 - F) * (1.0 - metallic);
  vec3 diff = kd * albedo / 3.14159265;
  vec3 spec = (D * F * G) / max(4.0 * NdotV * NdotL, 1e-4);
  return (diff + spec) * lightColor * NdotL * 3.14159265;
}

void main() {
  vec3 albedo = uAlbedo;
  float alpha = uOpacity;
  if (uUseAlbedoMap == 1) {
    vec4 t = texture(uAlbedoMap, vUV);
    albedo *= t.rgb;
    alpha *= t.a;
  }
  if (uAlphaMode == 1 && alpha < uAlphaCutoff) discard;
  float metallic = uMetallic;
  float roughness = uRoughness;
  if (uUseMetalRough == 1) {
    vec4 mr = texture(uMetalRoughMap, vUV);
    metallic = mr.b;
    roughness = mr.g;
  }
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 N = normalize(vNormal);
  if (uUseNormalMap == 1) N = perturbNormal(N, V);
  float ao = 1.0;
  if (uUseAO == 1) ao = mix(1.0, texture(uAOMap, vUV).r, uAOStrength);
  vec3 skyAmb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  vec3 ambient = skyAmb * albedo * ao * uAmbientStrength;
  vec3 Lo = brdf(albedo, metallic, roughness, N, V, normalize(-uLightDir), vec3(1.0) * uLightIntensity);
  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 toL = uPointPos[i] - vWorldPos;
    float d = length(toL);
    float att = 1.0 / (1.0 + 0.25 * d * d);
    Lo += brdf(albedo, metallic, roughness, N, V, normalize(toL), uPointColor[i] * att);
  }
  vec3 emission = uEmissive * uEmissiveIntensity;
  if (uUseEmissiveMap == 1) emission *= texture(uEmissiveMap, vUV).rgb;
  vec3 col = ambient + Lo + emission;
  float fd = length(vWorldPos - uCamPos);
  float f = smoothstep(uFogNear, uFogFar, fd);
  col = mix(col, uFogColor, f);
  outColor = vec4(col, alpha);
}`;

// Terrain fragment: splat-mapped matte surfacing (no specular — earth doesn't
// shine). Shares VERT_SRC varyings. Detail textures tile by vUV; the splat
// mask is sampled unscaled (0..1 across the patch).
export const TERRAIN_FRAG_SRC = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorldPos;
in vec2 vUV;
uniform sampler2D uSplatMap;
uniform sampler2D uDetailA;
uniform sampler2D uDetailB;
uniform sampler2D uDetailC;
uniform float uDetailTiling;
uniform vec3 uLightDir;
uniform float uLightIntensity;
uniform vec3 uCamPos;
uniform int uPointCount;
uniform vec3 uPointPos[4];
uniform vec3 uPointColor[4];
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 weights = texture(uSplatMap, vUV).rgb;
  float wsum = weights.r + weights.g + weights.b + 1e-4;
  weights /= wsum;
  vec3 albedo =
    texture(uDetailA, vUV * uDetailTiling).rgb * weights.r +
    texture(uDetailB, vUV * uDetailTiling).rgb * weights.g +
    texture(uDetailC, vUV * uDetailTiling).rgb * weights.b;
  vec3 l = normalize(-uLightDir);
  float diff = max(dot(n, l), 0.0) * uLightIntensity;
  vec3 ambient = vec3(0.3);
  vec3 col = albedo * (ambient + diff * 0.9);
  for (int i = 0; i < 4; i++) {
    if (i >= uPointCount) break;
    vec3 toL = uPointPos[i] - vWorldPos;
    float d = length(toL);
    float att = 1.0 / (1.0 + 0.25 * d * d);
    float pd = max(dot(n, normalize(toL)), 0.0) * att;
    col += albedo * uPointColor[i] * pd;
  }
  float fd = length(vWorldPos - uCamPos);
  float f = smoothstep(uFogNear, uFogFar, fd);
  col = mix(col, uFogColor, f);
  outColor = vec4(col, 1.0);
}`;
