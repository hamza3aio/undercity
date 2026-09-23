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
}
