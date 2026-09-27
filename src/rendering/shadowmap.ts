// Glitch shadow mapping — single-cascade directional shadows.
// The top half is pure math (ortho fitting, texel snapping, bias, PCF
// kernel) so it is testable headless; ShadowMap at the bottom owns the GL
// depth texture + framebuffer. Receiver sampling lives in the fragment
// shaders (shadowReceiverGLSL in shader.ts) and mirrors shadowSample() here.
// Known limits, deliberately not faked: one cascade, no point/spot shadow
// maps, no occlusion culling, no shadow LOD.

import { Mat4 } from "../math/mat4.js";
import { Vec3 } from "../math/vec3.js";

export interface ShadowFitOpts {
  lightDir: Vec3; // direction the light travels (same convention as Renderer.lightDir)
  center: Vec3; // world point the map is centered on
  radius: number; // world-space radius the map must cover
  mapSize: number; // shadow map resolution in texels
  depthRange?: number; // depth thickness of the ortho box (default: radius*4)
}

export interface ShadowFit {
  view: Mat4;
  proj: Mat4;
  matrix: Mat4; // proj * view
  texelWorld: number; // world units per shadow texel
  radius: number;
  depthRange: number;
  center: Vec3; // the requested center
  snappedCenter: Vec3; // where the map is actually anchored (texel grid)
}

export const MIN_SHADOW_SIZE = 256;
export const MAX_SHADOW_SIZE = 8192;

function normalized(v: Vec3, fallback: Vec3): Vec3 {
  if (!(Math.hypot(v.x, v.y, v.z) > 1e-8)) return fallback;
  return new Vec3(v.x, v.y, v.z).normalize();
}

export function sanitizeShadowSize(size: number): number {
  if (!Number.isFinite(size)) return 2048;
  // Round to a power of two inside the supported window: hardware mip/compare
  // paths assume POT, and POT keeps the PCF texel size exact.
  const clamped = Math.max(MIN_SHADOW_SIZE, Math.min(MAX_SHADOW_SIZE, Math.round(size)));
  return 1 << Math.round(Math.log2(clamped));
}

// Ortho box centered on `center`, facing along -lightDir, snapped so the
// shadow texels stay world-anchored (this is what stops shimmering when the
// camera creeps). Returns the matrix used for both the depth pass and the
// receiver lookup.
export function fitDirectionalShadow(o: ShadowFitOpts): ShadowFit {
  if (!(o.radius > 0)) throw new Error("fitDirectionalShadow: radius must be positive");
  const size = sanitizeShadowSize(o.mapSize);
  const L = normalized(o.lightDir, new Vec3(-0.5, -1, -0.3)).negate(); // toward the light
  const depthRange = o.depthRange !== undefined && o.depthRange > 0 ? o.depthRange : o.radius * 4;

  // The light-space basis is fixed by lightDir/up alone, so the texel grid can
  // be anchored to world space instead of to the per-frame center: the whole
  // fit derives from the *snapped* light-space position, so two centers inside
  // the same texel produce a bit-identical matrix. That is what stops shadow
  // crawl as the camera moves.
  const up = Math.abs(L.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
  const basis = Mat4.lookAt(new Vec3(0, 0, 0), L, up);
  const be = basis.elements;
  const axisX = new Vec3(be[0], be[4], be[8]);
  const axisY = new Vec3(be[1], be[5], be[9]);
  const axisZ = new Vec3(be[2], be[6], be[10]);
  const texelWorld = (2 * o.radius) / size;
  // Light-space coords of the center in a world-anchored frame (origin at 0).
  const fx = o.center.dot(axisX);
  const fy = o.center.dot(axisY);
  const fz = o.center.dot(axisZ);
  const sx = Math.round(fx / texelWorld) * texelWorld;
  const sy = Math.round(fy / texelWorld) * texelWorld;
  // Rebuild the snapped center without mutating the basis (Vec3.scale/add
  // mutate in place, so they cannot be used on the basis vectors).
  const center = new Vec3(
    axisX.x * sx + axisY.x * sy + axisZ.x * fz,
    axisX.y * sx + axisY.y * sy + axisZ.y * fz,
    axisX.z * sx + axisY.z * sy + axisZ.z * fz
  );
  // Eye sits half a depthRange back along the light so the box spans
  // center +/- depthRange/2 along the light axis (casters on both sides).
  const eye = new Vec3(
    center.x - L.x * depthRange * 0.5,
    center.y - L.y * depthRange * 0.5,
    center.z - L.z * depthRange * 0.5
  );
  // Built directly from the same basis used for snapping (instead of a second
  // lookAt call) so the snapped position stays exact in light space.
  const view = new Mat4();
  const ve = view.elements;
  // Transposed basis (same layout Mat4.lookAt writes), then the -axis.dot(eye)
  // translation row.
  ve[0] = axisX.x; ve[1] = axisY.x; ve[2] = axisZ.x;
  ve[4] = axisX.y; ve[5] = axisY.y; ve[6] = axisZ.y;
  ve[8] = axisX.z; ve[9] = axisY.z; ve[10] = axisZ.z;
  ve[12] = -axisX.dot(eye); ve[13] = -axisY.dot(eye); ve[14] = -axisZ.dot(eye);
  ve[15] = 1;
  const proj = Mat4.ortho(-o.radius, o.radius, -o.radius, o.radius, 0.0, depthRange);
  return {
    view, proj, matrix: Mat4.multiplied(proj, view),
    texelWorld, radius: o.radius, depthRange,
    center: o.center.clone(), snappedCenter: center,
  };
}

// Depth bias for the receiver compare. `depth` is the [0,1] shadow-map
// reference value, so the result lives in the same units. Slope-scaled:
// grazing light needs more.
export function shadowDepthBias(ndotl: number, texelWorld: number, depthRange: number, base: number, slopeScale: number): number {
  const slope = 1 - Math.max(0, Math.min(1, ndotl));
  return base + slopeScale * slope * (texelWorld * 2) / Math.max(1e-6, depthRange);
}

// Receiver world-space offset along the surface normal, scaled by how
// grazing the light is. Kills acne without the peter-panning a depth-only
// bias would cause on thin geometry.
export function normalOffsetWorld(normal: Vec3, lightDir: Vec3, texelWorld: number, scale: number): Vec3 {
  const n = normalized(normal, new Vec3(0, 1, 0));
  const L = normalized(lightDir, new Vec3(0, -1, 0)).negate();
  const k = texelWorld * scale * (1 - Math.max(0, Math.min(1, n.dot(L))));
  return new Vec3(n.x * k, n.y * k, n.z * k);
}

// Fixed Vogel-style disk, deterministic, radius in shadow texels. Used by
// the editor's soft-shadow setting and available to the receiver shader.
export function pcfKernel(samples: number, radiusTexels: number): { x: number; y: number }[] {
  const n = Math.max(1, Math.min(64, Math.round(samples)));
  const out: { x: number; y: number }[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n) * Math.max(0, radiusTexels);
    const a = i * ga;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

// Reference receiver math. Returns 0 (fully shadowed) .. 1 (lit). `texture()`
// here stands in for the GPU's filtered depth compare: occluded when the
// stored depth is closer than `ref`. Mirrors shadowFactor() in the shaders.
// No occluder inside the filter radius means nothing to occlude -> lit.
export function shadowSample(
  occluderDepths: { u: number; v: number; d: number }[],
  u: number, v: number, ref: number, pcfTexels: number
): number {
  let taps = 0;
  let lit = 0;
  for (const o of occluderDepths) {
    if (Math.abs(o.u - u) > pcfTexels || Math.abs(o.v - v) > pcfTexels) continue;
    taps++;
    lit += o.d >= ref ? 1 : 0; // LEQUAL compare: stored depth >= ref means lit
  }
  return taps === 0 ? 1 : lit / taps;
}

// Conservative sphere-vs-shadow-box test. `m` is the shadow matrix
// (proj * view): NDC x/y are scaled by halfExtent, and NDC z maps linearly
// from [0, depthRange] measured at the light eye. Used to skip casters that
// cannot possibly land inside the cascade.
export function sphereInsideShadow(
  m: Mat4, center: Vec3, radius: number, halfExtent: number, depthRange: number
): boolean {
  const p = m.transformPoint(center);
  const lx = p.x * halfExtent;
  const ly = p.y * halfExtent;
  const lz = ((p.z + 1) / 2) * depthRange;
  return (
    Math.abs(lx) <= halfExtent + radius &&
    Math.abs(ly) <= halfExtent + radius &&
    lz >= -radius &&
    lz <= depthRange + radius
  );
}

// --- GL resource ---

export class ShadowMap {
  private gl: WebGL2RenderingContext;
  private fb: WebGLFramebuffer | null = null;
  private tex: WebGLTexture | null = null;
  private w = 0;
  private h = 0;
  complete = false;

  constructor(gl: WebGL2RenderingContext, size: number) {
    this.gl = gl;
    this.resize(size);
  }

  get size(): number {
    return this.w;
  }

  get texture(): WebGLTexture | null {
    return this.tex;
  }

  resize(size: number): void {
    const gl = this.gl;
    const s = sanitizeShadowSize(size);
    if (this.w === s && this.fb) return;
    this.free();
    this.w = s;
    this.h = s;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, s, s, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.tex, 0);
    // Depth-only: explicitly declare "no color outputs" or the FBO is
    // incomplete on some drivers.
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    this.complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Bind for the depth pass: clear depth only, color mask off.
  beginPass(): void {
    const gl = this.gl;
    if (!this.fb) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.colorMask(false, false, false, false);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  endPass(): void {
    const gl = this.gl;
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private free(): void {
    const gl = this.gl;
    if (this.fb) gl.deleteFramebuffer(this.fb);
    if (this.tex) gl.deleteTexture(this.tex);
    this.fb = null;
    this.tex = null;
    this.complete = false;
    this.w = 0;
    this.h = 0;
  }

  dispose(): void {
    this.free();
  }
}
