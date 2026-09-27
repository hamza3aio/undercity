import { Mat4 } from "../math/mat4.js";
import { Vec3 } from "../math/vec3.js";
import { FRAG_SRC, VERT_SRC, INST_FRAG_SRC, INST_VERT_SRC, PBR_FRAG_SRC, TERRAIN_FRAG_SRC, POST_VERT_SRC, POST_FRAG_SRC, FX_FRAG_SRC, SHADOW_FRAG_SRC, SKINNED_VERT_SRC, createProgram } from "./shader.js";
import { MAX_BONES_PER_PALETTE, SkinnedMeshRegistry } from "./skinning.js";
import { GpuMesh, boundsRadius, cubeData, planeData, type MeshData } from "./mesh.js";
import { Texture2D } from "./texture.js";
import { MaterialDB, resolveMaterial, type PBRMaterial } from "./materials.js";
import { frustumFromVP, testSphere, type Plane } from "./frustum.js";
import { InstancedMesh, FLOATS_PER_INSTANCE, MAX_BATCH, MIN_INSTANCES, composeInstance, groupInstances } from "./instancing.js";
import type { PointLight, SpotLight } from "./lights.js";
import { rankLights } from "./lights.js";
import { PostChain } from "./post.js";
import { PostStack, type PostPassKind } from "./poststack.js";
import { ShadowMap, fitDirectionalShadow, sphereInsideShadow, type ShadowFit } from "./shadowmap.js";
import type { QualitySettings } from "../core/quality.js";
import { TONE_MAP_MODES, type ToneMapMode } from "./tonemap.js";
import { LODTracker, type LODLevel } from "./lod.js";

export interface ShadowSettings {
  enabled: boolean;
  size: number; // shadow map resolution (power of two)
  distance: number; // world radius the single cascade covers around the camera target
  bias: number; // depth bias
  normalBias: number; // normal-offset bias, in texels
  strength: number; // 0..1 darkness of full shadow
}

function defaultShadowSettings(): ShadowSettings {
  return { enabled: false, size: 2048, distance: 42, bias: 0.0018, normalBias: 1.6, strength: 0.72 };
}

// Every lit program receives these; kept in one list so a new program
// cannot silently miss a uniform.
const SHADOW_UNIFORM_NAMES = [
  "uShadowMap", "uShadowMatrix", "uShadowTexelUV", "uShadowTexel",
  "uShadowBias", "uShadowNormalBias", "uShadowStrength", "uEnableShadows",
] as const;

const TONEMAP_UNIFORM_NAMES = ["uTonemap", "uExposure", "uGamma"] as const;

// Added in v2.18 alongside the point-light uniforms.
const SPOT_UNIFORM_NAMES = ["uPointRange", "uSpotCount", "uPointDir", "uSpotCos"] as const;

const SHADOW_TEXTURE_UNIT = 4; // 0..3 are used by the terrain splat/detail set

// Offscreen effect modes (must match FX_FRAG_SRC branches).
const FX_MODE: Record<string, number> = { blur: 0, bloom: 1, ao: 2, grain: 3, sharpen: 4 };

// Output stage (Phase 2). All three are no-ops at their defaults, so turning
// them on is always an explicit, opt-in change.
export interface TonemapSettings {
  mode: ToneMapMode;
  exposure: number;
  gamma: number;
}
import type { TerrainMaterial } from "../world/terrain.js";
import type { Entity } from "../ecs/world.js";
import { World } from "../ecs/world.js";
import type { MeshRef, Transform } from "../ecs/components.js";
import { Camera } from "./camera.js";

export interface RenderStats {
  total: number;
  drawn: number;
  culled: number;
  instancedDraws: number;
  regularDraws: number;
  pbrDraws: number;
  postDraws: number;
  shadowDraws: number;
  skinnedDraws: number;
  fxDraws: number;
  /** Entities drawn with a reduced-detail LOD this frame. */
  lodDraws: number;
  /** Entities dropped because their LOD chain's cull floor was passed. */
  lodCulled: number;
}

interface VisibleItem {
  t: Transform;
  m: MeshRef;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private instProgram: WebGLProgram;
  private pbrProgram: WebGLProgram;
  private terrainProgram: WebGLProgram;
  private meshes = new Map<string, GpuMesh>();
  private meshData = new Map<string, MeshData>();
  private meshBounds = new Map<string, number>();
  private instanced = new Map<string, InstancedMesh>();
  private scratch = new Float32Array(MAX_BATCH * FLOATS_PER_INSTANCE);
  /** Per-entity LOD level history, so hysteresis works across frames. */
  private lod = new LODTracker();
  textures = new Map<string, Texture2D>();
  camera = new Camera();
  lightDir = new Vec3(-0.5, -1, -0.3);
  lightIntensity = 1.0;
  pointLights: PointLight[] = [];
  /** Spot lights compete for the same 4 slots (Phase 3). */
  spotLights: SpotLight[] = [];
  clearColor: [number, number, number] = [0.07, 0.09, 0.14];
  fogColor: [number, number, number] = [0.05, 0.06, 0.1];
  fogNear = 40;
  fogFar = 200;
  skyColor: [number, number, number] = [0.5, 0.6, 0.75];
  groundColor: [number, number, number] = [0.12, 0.1, 0.09];
  ambientStrength = 1.0;
  materials = new MaterialDB();
  readonly stats: RenderStats = { total: 0, drawn: 0, culled: 0, instancedDraws: 0, regularDraws: 0, pbrDraws: 0, postDraws: 0, shadowDraws: 0, skinnedDraws: 0, fxDraws: 0, lodDraws: 0, lodCulled: 0 };
  /** Skinned meshes live outside the static mesh table (Phase 9). */
  skinned!: SkinnedMeshRegistry;
  private skinnedProgram!: WebGLProgram;
  private kloc: Record<string, WebGLUniformLocation | null> = {};
  private paletteScratch = new Float32Array(MAX_BONES_PER_PALETTE * 16);
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private iloc: Record<string, WebGLUniformLocation | null> = {};
  private ploc: Record<string, WebGLUniformLocation | null> = {};
  private tloc: Record<string, WebGLUniformLocation | null> = {};
  private postloc: Record<string, WebGLUniformLocation | null> = {};
  post = new PostStack();
  /** @deprecated legacy single-chain alias; prefer `post`. */
  legacyPost = new PostChain();
  /** Render-resolution multiplier from the quality config (0.5..1). */
  pixelScale = 1;
  /** Master fog switch (quality config). */
  fogEnabled = true;
  /** Upper bound on point lights uploaded to shaders (0..4). */
  maxPointLights = 4;
  shadows: ShadowSettings = defaultShadowSettings();
  tonemap: TonemapSettings = { mode: "none", exposure: 1, gamma: 1 };
  /** Optional player-facing quality config; applied on every frame. */
  quality: QualitySettings | null = null;
  private shadowProgram!: WebGLProgram;
  private shadowInstProgram!: WebGLProgram;
  private shadowMap: ShadowMap | null = null;
  private shadowFit: ShadowFit | null = null;
  private shadowActive = false;
  private sloc: Record<string, WebGLUniformLocation | null> = {};
  private siloc: Record<string, WebGLUniformLocation | null> = {};
  private postProgram!: WebGLProgram;
  private fxProgram!: WebGLProgram;
  private fxloc: Record<string, WebGLUniformLocation | null> = {};
  private fxFB: WebGLFramebuffer | null = null;
  private fxTex: WebGLTexture | null = null;
  private fxW = 0;
  private fxH = 0;
  private sceneFB: WebGLFramebuffer | null = null;
  private sceneTex: WebGLTexture | null = null;
  private sceneDepth: WebGLRenderbuffer | null = null;
  private postW = 0;
  private postH = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 not supported in this browser.");
    this.gl = gl;
    this.program = createProgram(gl, VERT_SRC, FRAG_SRC);
    for (const name of [
      "uModel", "uView", "uProj", "uColor", "uLightDir", "uLightIntensity",
      "uCamPos", "uShininess", "uMap", "uUseTexture", "uUVScale",
      "uPointCount", "uPointPos", "uPointColor",
      "uFogColor", "uFogNear", "uFogFar",
      ...SHADOW_UNIFORM_NAMES,
      ...TONEMAP_UNIFORM_NAMES,
      ...SPOT_UNIFORM_NAMES,
    ]) {
      this.loc[name] = gl.getUniformLocation(this.program, name);
    }
    this.instProgram = createProgram(gl, INST_VERT_SRC, INST_FRAG_SRC);
    for (const name of [
      "uView", "uProj", "uLightDir", "uLightIntensity",
      "uCamPos", "uMap", "uUseTexture",
      "uPointCount", "uPointPos", "uPointColor",
      "uFogColor", "uFogNear", "uFogFar",
      ...SHADOW_UNIFORM_NAMES,
      ...TONEMAP_UNIFORM_NAMES,
      ...SPOT_UNIFORM_NAMES,
    ]) {
      this.iloc[name] = gl.getUniformLocation(this.instProgram, name);
    }
    this.pbrProgram = createProgram(gl, VERT_SRC, PBR_FRAG_SRC);
    for (const name of [
      "uModel", "uView", "uProj", "uUVScale", "uCamPos",
      "uAlbedo", "uMetallic", "uRoughness",
      "uAlbedoMap", "uMetalRoughMap", "uNormalMap", "uAOMap", "uEmissiveMap",
      "uUseAlbedoMap", "uUseMetalRough", "uUseNormalMap", "uUseAO", "uUseEmissiveMap",
      "uNormalScale", "uAOStrength", "uEmissive", "uEmissiveIntensity",
      "uOpacity", "uAlphaMode", "uAlphaCutoff",
      "uLightDir", "uLightIntensity",
      "uPointCount", "uPointPos", "uPointColor",
      "uFogColor", "uFogNear", "uFogFar",
      "uSkyColor", "uGroundColor", "uAmbientStrength",
      ...SHADOW_UNIFORM_NAMES,
      ...TONEMAP_UNIFORM_NAMES,
      ...SPOT_UNIFORM_NAMES,
    ]) {
      this.ploc[name] = gl.getUniformLocation(this.pbrProgram, name);
    }
    this.materials.presets();
    this.terrainProgram = createProgram(gl, VERT_SRC, TERRAIN_FRAG_SRC);
    for (const name of [
      "uModel", "uView", "uProj", "uUVScale", "uCamPos",
      "uSplatMap", "uDetailA", "uDetailB", "uDetailC", "uDetailTiling",
      "uLightDir", "uLightIntensity",
      "uPointCount", "uPointPos", "uPointColor",
      "uFogColor", "uFogNear", "uFogFar",
      ...SHADOW_UNIFORM_NAMES,
      ...TONEMAP_UNIFORM_NAMES,
      ...SPOT_UNIFORM_NAMES,
    ]) {
      this.tloc[name] = gl.getUniformLocation(this.terrainProgram, name);
    }
    this.postProgram = createProgram(gl, POST_VERT_SRC, POST_FRAG_SRC);
    this.fxProgram = createProgram(gl, POST_VERT_SRC, FX_FRAG_SRC);
    for (const name of ["uScene", "uTexel", "uMode", "uRadius", "uTaps", "uThreshold", "uIntensity", "uSeed"]) {
      this.fxloc[name] = gl.getUniformLocation(this.fxProgram, name);
    }
    this.skinned = new SkinnedMeshRegistry(gl);
    this.skinnedProgram = createProgram(gl, SKINNED_VERT_SRC, FRAG_SRC);
    for (const name of [
      "uModel", "uUVScale", "uView", "uProj", "uPalette", "uBoneCount",
      "uColor", "uLightDir", "uLightIntensity",
      "uCamPos", "uShininess", "uMap", "uUseTexture",
      "uPointCount", "uPointPos", "uPointColor",
      "uFogColor", "uFogNear", "uFogFar",
      "uTonemap", "uExposure", "uGamma",
      "uPointRange", "uSpotCount", "uPointDir", "uSpotCos",
      "uShadowMap", "uShadowMatrix", "uShadowTexelUV", "uShadowTexel",
      "uShadowBias", "uShadowNormalBias", "uShadowStrength", "uEnableShadows",
    ]) {
      this.kloc[name] = gl.getUniformLocation(this.skinnedProgram, name);
    }
    for (const name of ["uScene", "uExposure", "uContrast", "uSaturation", "uTemperature", "uVignette", "uVignetteSoft"]) {
      this.postloc[name] = gl.getUniformLocation(this.postProgram, name);
    }
    // Shadow depth pass reuses the lit vertex stages; only the fragment
    // stage differs (writes nothing - depth-only FBO).
    this.shadowProgram = createProgram(gl, VERT_SRC, SHADOW_FRAG_SRC);
    for (const name of ["uModel", "uView", "uProj", "uUVScale"]) {
      this.sloc[name] = gl.getUniformLocation(this.shadowProgram, name);
    }
    this.shadowInstProgram = createProgram(gl, INST_VERT_SRC, SHADOW_FRAG_SRC);
    for (const name of ["uView", "uProj"]) {
      this.siloc[name] = gl.getUniformLocation(this.shadowInstProgram, name);
    }
    this.registerMesh("cube", cubeData(1));
    this.registerMesh("ground", planeData(140));
    this.textures.set("white", Texture2D.white(gl));
    this.textures.set("checker", Texture2D.checker(gl));
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  registerMesh(id: string, data: MeshData) {
    this.meshes.set(id, new GpuMesh(this.gl, data));
    this.meshData.set(id, data);
    this.meshBounds.set(id, boundsRadius(data));
    this.instanced.delete(id); // stale batch VAO (if any) must not survive
  }

  registerTexture(id: string, tex: Texture2D) {
    this.textures.set(id, tex);
  }

  registerCanvas(id: string, img: TexImageSource) {
    const tex = new Texture2D(this.gl);
    tex.fromImage(img);
    this.textures.set(id, tex);
  }

  dispose() {
    for (const im of this.instanced.values()) im.dispose();
    this.instanced.clear();
    this.shadowMap?.dispose();
    this.shadowMap = null;
    this.deleteSceneTarget();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.max(0.5, Math.min(1, this.pixelScale));
    const w = Math.floor((this.canvas.clientWidth * dpr) * scale) || Math.floor(window.innerWidth * dpr * scale);
    const h = Math.floor((this.canvas.clientHeight * dpr) * scale) || Math.floor(window.innerHeight * dpr * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private uploadShared(loc: Record<string, WebGLUniformLocation | null>, view: Mat4, proj: Mat4) {    const gl = this.gl;
    gl.uniformMatrix4fv(loc.uView, false, view.elements);
    gl.uniformMatrix4fv(loc.uProj, false, proj.elements);
    this.uploadShadow(loc);
    this.uploadTonemap(loc);
    this.refreshLightSlots();
    gl.uniform3fv(loc.uLightDir, this.lightDir.toArray() as unknown as Float32List);
    gl.uniform1f(loc.uLightIntensity, this.lightIntensity);
    gl.uniform3fv(loc.uCamPos, this.camera.position.toArray() as unknown as Float32List);
    gl.uniform1i(loc.uMap, 0);
    gl.uniform3fv(loc.uFogColor, this.fogColor as unknown as Float32List);
    gl.uniform1f(loc.uFogNear, this.fogNear);
    gl.uniform1f(loc.uFogFar, this.fogEnabled ? this.fogFar : 1e9);
    const count = this.slotCount();
    gl.uniform1i(loc.uPointCount, count);
    if (count > 0) {
      const posArr = new Float32Array(12);
      const colArr = new Float32Array(12);
      const rangeArr = new Float32Array(4);
      const dirArr = new Float32Array(12);
      const cosArr = new Float32Array(8);
      const slots = this.slots;
      let spots = 0;
      for (let i = 0; i < count; i++) {
        const s = slots[i];
        posArr[i * 3] = s.position.x; posArr[i * 3 + 1] = s.position.y; posArr[i * 3 + 2] = s.position.z;
        colArr[i * 3] = s.color[0] * s.intensity; colArr[i * 3 + 1] = s.color[1] * s.intensity; colArr[i * 3 + 2] = s.color[2] * s.intensity;
        rangeArr[i] = s.range;
        if (s.isSpot) {
          const sp = s.light as SpotLight;
          // Shaders receive the vector pointing back at the light.
          dirArr[i * 3] = -sp.direction.x; dirArr[i * 3 + 1] = -sp.direction.y; dirArr[i * 3 + 2] = -sp.direction.z;
          cosArr[i * 2] = Math.cos(sp.outerAngle);
          cosArr[i * 2 + 1] = Math.cos(sp.innerAngle);
          spots++;
        } else {
          dirArr[i * 3] = 0; dirArr[i * 3 + 1] = 1; dirArr[i * 3 + 2] = 0;
          cosArr[i * 2] = -1; cosArr[i * 2 + 1] = 1;
        }
      }
      gl.uniform3fv(loc.uPointPos, posArr as unknown as Float32List);
      gl.uniform3fv(loc.uPointColor, colArr as unknown as Float32List);
      gl.uniform1fv(loc.uPointRange, rangeArr);
      gl.uniform3fv(loc.uPointDir, dirArr as unknown as Float32List);
      gl.uniform2fv(loc.uSpotCos, cosArr);
      gl.uniform1i(loc.uSpotCount, spots);
    }
  }

  private drawPBR(t: Transform, m: MeshRef, mat: PBRMaterial, view: Mat4, proj: Mat4) {
    const gl = this.gl;
    const gpu = this.meshes.get(m.meshId)!;
    gl.useProgram(this.pbrProgram);
    this.uploadShared(this.ploc, view, proj);
    const L = this.ploc;
    const model = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
    gl.uniformMatrix4fv(L.uModel, false, model.elements);
    gl.uniform1f(L.uUVScale, m.uvScale ?? 1);
    gl.uniform3fv(L.uAlbedo, mat.albedo as unknown as Float32List);
    gl.uniform1f(L.uMetallic, mat.metallic);
    gl.uniform1f(L.uRoughness, mat.roughness);
    gl.uniform1f(L.uNormalScale, mat.normalScale);
    gl.uniform1f(L.uAOStrength, mat.aoStrength);
    gl.uniform3fv(L.uEmissive, mat.emissive as unknown as Float32List);
    gl.uniform1f(L.uEmissiveIntensity, mat.emissiveIntensity);
    gl.uniform1f(L.uOpacity, mat.opacity);
    gl.uniform1i(L.uAlphaMode, mat.alphaMode === "mask" ? 1 : 0);
    gl.uniform1f(L.uAlphaCutoff, mat.alphaCutoff);
    const bindMap = (sampler: WebGLUniformLocation | null, useFlag: WebGLUniformLocation | null, unit: number, id: string | undefined) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const tex = (id && this.textures.get(id)) || this.textures.get("white")!;
      tex.bind(unit);
      gl.uniform1i(sampler, unit);
      gl.uniform1i(useFlag, id && this.textures.get(id) ? 1 : 0);
    };
    bindMap(L.uAlbedoMap, L.uUseAlbedoMap, 0, mat.albedoMap);
    bindMap(L.uMetalRoughMap, L.uUseMetalRough, 1, mat.metalRoughMap);
    bindMap(L.uNormalMap, L.uUseNormalMap, 2, mat.normalMap);
    bindMap(L.uAOMap, L.uUseAO, 3, mat.aoMap);
    bindMap(L.uEmissiveMap, L.uUseEmissiveMap, 4, mat.emissiveMap);
    gl.uniform3fv(L.uSkyColor, this.skyColor as unknown as Float32List);
    gl.uniform3fv(L.uGroundColor, this.groundColor as unknown as Float32List);
    gl.uniform1f(L.uAmbientStrength, this.ambientStrength);
    const blend = mat.alphaMode === "blend";
    const cull = !mat.doubleSided;
    if (!cull) gl.disable(gl.CULL_FACE);
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    gpu.draw();
    if (blend) gl.disable(gl.BLEND);
    if (!cull) gl.enable(gl.CULL_FACE);
    this.stats.pbrDraws++;
    this.stats.drawn++;
  }

  private drawTerrain(t: Transform, m: MeshRef, tm: TerrainMaterial, view: Mat4, proj: Mat4) {
    const gl = this.gl;
    const gpu = this.meshes.get(m.meshId)!;
    gl.useProgram(this.terrainProgram);
    this.uploadShared(this.tloc, view, proj);
    const L = this.tloc;
    const model = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
    gl.uniformMatrix4fv(L.uModel, false, model.elements);
    gl.uniform1f(L.uUVScale, 1);
    gl.uniform1f(L.uDetailTiling, tm.detailScale);
    const bind = (loc: WebGLUniformLocation | null, unit: number, id: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      const tex = this.textures.get(id) || this.textures.get("white")!;
      tex.bind(unit);
      gl.uniform1i(loc, unit);
    };
    bind(L.uSplatMap, 0, tm.splat);
    bind(L.uDetailA, 1, tm.detailA);
    bind(L.uDetailB, 2, tm.detailB);
    bind(L.uDetailC, 3, tm.detailC);
    gpu.draw();
    this.stats.regularDraws++;
    this.stats.drawn++;
  }

  private drawSingle(t: Transform, m: MeshRef) {
    const gl = this.gl;
    const gpu = this.meshes.get(m.meshId)!;
    const model = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
    gl.uniformMatrix4fv(this.loc.uModel, false, model.elements);
    gl.uniform3fv(this.loc.uColor, m.color as unknown as Float32List);
    gl.uniform1f(this.loc.uShininess, m.shininess ?? 32);
    gl.uniform1f(this.loc.uUVScale, m.uvScale ?? 1);
    const tex = (m.textureId && this.textures.get(m.textureId)) || this.textures.get("white")!;
    tex.bind(0);
    gl.uniform1i(this.loc.uUseTexture, m.textureId ? 1 : 0);
    gpu.draw();
    this.stats.regularDraws++;
    this.stats.drawn++;
  }

  private drawBatch(meshId: string, textureId: string | undefined, items: VisibleItem[]) {
    const gl = this.gl;
    let batch = this.instanced.get(meshId);
    if (!batch) {
      const data = this.meshData.get(meshId)!;
      batch = new InstancedMesh(gl, data);
      this.instanced.set(meshId, batch);
    }
    gl.useProgram(this.instProgram);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    this.uploadShared(this.iloc, this.camera.view(), this.camera.projection(aspect));
    const tex = (textureId && this.textures.get(textureId)) || this.textures.get("white")!;
    tex.bind(0);
    gl.uniform1i(this.iloc.uUseTexture, textureId ? 1 : 0);
    for (let start = 0; start < items.length; start += MAX_BATCH) {
      const chunk = items.slice(start, start + MAX_BATCH);
      for (let i = 0; i < chunk.length; i++) {
        const { t, m } = chunk[i];
        const o = i * FLOATS_PER_INSTANCE;
        composeInstance(
          this.scratch, o,
          t.position.x, t.position.y, t.position.z, t.rotationY,
          t.scale.x, t.scale.y, t.scale.z
        );
        this.scratch[o + 16] = m.color[0];
        this.scratch[o + 17] = m.color[1];
        this.scratch[o + 18] = m.color[2];
        this.scratch[o + 19] = m.uvScale ?? 1;
        this.scratch[o + 20] = m.shininess ?? 32;
      }
      batch.write(this.scratch, chunk.length);
      batch.draw(chunk.length);
      this.stats.instancedDraws++;
      this.stats.drawn += chunk.length;
    }
  }

  /** Light slots for one frame, ranked by apparent brightness at the camera target. */
  private slots: { light: PointLight | SpotLight; isSpot: boolean; position: Vec3; color: [number, number, number]; intensity: number; range: number }[] = [];

  private slotCount(): number {
    return Math.max(0, Math.min(4, this.slots.length, this.maxPointLights));
  }

  /**
   * Re-ranks point+spot lights into the 4 uploaded slots. Called once per
   * frame from uploadShared: a handful of lights, so the sort is free and
   * there is no cache to go stale when game code mutates the arrays.
   */
  refreshLightSlots(): void {
    const all: (PointLight | SpotLight)[] = [...this.pointLights, ...this.spotLights];
    if (all.length === 0) {
      this.slots = [];
      return;
    }
    const kinds: ("point" | "spot")[] = [
      ...this.pointLights.map(() => "point" as const),
      ...this.spotLights.map(() => "spot" as const),
    ];
    const ranked = rankLights(all, kinds, this.camera.target, Math.max(0, Math.min(4, this.maxPointLights)));
    this.slots = ranked.map((r) => {
      const l = all[r.index];
      return {
        light: l, isSpot: r.kind === "spot", position: l.position,
        color: l.color, intensity: l.intensity, range: l.range,
      };
    });
  }

  /**
   * Registers a bone palette provider. Every frame, each entity that has
   * both a `skinned` mesh and an animator draws through SKINNED_VERT_SRC.
   * `provider(entityId)` returns the bone matrices in world space.
   */
  onSkinProvider(provider: (e: Entity) => Mat4[] | null): void {
    this.skinProvider = provider;
  }
  private skinProvider: ((e: Entity) => Mat4[] | null) | null = null;

  private drawSkinned(e: Entity, t: Transform, m: MeshRef, view: Mat4, proj: Mat4): boolean {
    if (!this.skinProvider) return false;
    const palette = this.skinProvider(e);
    if (!palette || palette.length === 0) return false;
    const gpu = this.skinned.get(m.meshId);
    if (!gpu) return false;
    const gl = this.gl;
    const n = Math.min(palette.length, MAX_BONES_PER_PALETTE);
    for (let i = 0; i < n; i++) {
      this.paletteScratch.set(palette[i].elements, i * 16);
    }
    gl.useProgram(this.skinnedProgram);
    this.uploadShared(this.kloc, view, proj);
    const model = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
    gl.uniformMatrix4fv(this.kloc.uModel, false, model.elements);
    gl.uniform4fv(this.kloc.uPalette, this.paletteScratch.subarray(0, n * 16));
    gl.uniform1i(this.kloc.uBoneCount, n);
    gl.uniform3fv(this.kloc.uColor, m.color as unknown as Float32List);
    gl.uniform1f(this.kloc.uShininess, m.shininess ?? 32);
    gl.uniform1f(this.kloc.uUVScale, m.uvScale ?? 1);
    const tex = (m.textureId && this.textures.get(m.textureId)) || this.textures.get("white")!;
    tex.bind(0);
    gl.uniform1i(this.kloc.uUseTexture, m.textureId ? 1 : 0);
    gpu.draw();
    this.stats.skinnedDraws++;
    this.stats.regularDraws++;
    this.stats.drawn++;
    return true;
  }

  // Exposure / tone map / gamma for any lit program.
  private uploadTonemap(loc: Record<string, WebGLUniformLocation | null>) {
    const gl = this.gl;
    const mode = TONE_MAP_MODES.indexOf(this.tonemap.mode);
    gl.uniform1i(loc.uTonemap, mode < 0 ? 0 : mode);
    gl.uniform1f(loc.uExposure, Math.max(0, this.tonemap.exposure));
    gl.uniform1f(loc.uGamma, Math.max(1, this.tonemap.gamma));
  }

  // Pushes the player-facing quality config into renderer state. Called by
  // the engine every frame so a settings change needs no reload.
  applyQuality(q: QualitySettings): void {
    const c = q.config;
    this.quality = q;
    this.pixelScale = c.pixelScale;
    this.tonemap.mode = c.tonemap;
    this.tonemap.exposure = c.exposure;
    this.tonemap.gamma = c.gamma;
    this.shadows.enabled = c.shadowSize > 0;
    this.shadows.size = c.shadowSize;
    this.shadows.distance = c.shadowDistance;
    this.camera.far = c.viewDistance;
    this.fogEnabled = c.fogEnabled;
    this.fogFar = c.viewDistance;
    this.post.enabled = c.postEnabled;
    this.maxPointLights = c.pointLights;
  }

  // Shadow uniforms for any lit program. When shadows are off the sampler
  // is never bound and uEnableShadows=0 makes the shader return fully lit.
  private uploadShadow(loc: Record<string, WebGLUniformLocation | null>) {
    const gl = this.gl;
    const fit = this.shadowFit;
    const on = this.shadowActive && fit !== null && this.shadowMap !== null && this.shadowMap.complete;
    if (!on || !fit) {
      gl.uniform1i(loc.uEnableShadows, 0);
      return;
    }
    const sm = this.shadowMap!;
    gl.activeTexture(gl.TEXTURE0 + SHADOW_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, sm.texture);
    gl.uniform1i(loc.uShadowMap, SHADOW_TEXTURE_UNIT);
    gl.uniformMatrix4fv(loc.uShadowMatrix, false, fit.matrix.elements);
    gl.uniform2f(loc.uShadowTexelUV, 1 / sm.size, 1 / sm.size);
    gl.uniform1f(loc.uShadowTexel, fit.texelWorld);
    gl.uniform1f(loc.uShadowBias, this.shadows.bias);
    gl.uniform1f(loc.uShadowNormalBias, this.shadows.normalBias);
    gl.uniform1f(loc.uShadowStrength, Math.max(0, Math.min(1, this.shadows.strength)));
    gl.uniform1i(loc.uEnableShadows, 1);
  }

  // Depth-only pass from the light. Runs before the main target is bound.
  private drawShadowPass(world: World) {
    const gl = this.gl;
    if (!this.shadowMap) this.shadowMap = new ShadowMap(gl, this.shadows.size);
    else this.shadowMap.resize(this.shadows.size);
    if (!this.shadowMap.complete) {
      this.shadowActive = false;
      return;
    }
    const dist = Math.max(1, this.shadows.distance);
    this.shadowFit = fitDirectionalShadow({
      lightDir: this.lightDir,
      center: this.camera.target,
      radius: dist,
      mapSize: this.shadowMap.size,
    });
    const fit = this.shadowFit;
    const sm = this.shadowMap;

    // Casters: every mesh entity whose bounding sphere can reach the box.
    const casters: { t: Transform; meshId: string }[] = [];
    for (const e of world.query("transform", "mesh") as Entity[]) {
      const t = world.get<Transform>(e, "transform")!;
      const m = world.get<MeshRef>(e, "mesh")!;
      if (!this.meshes.has(m.meshId)) continue;
      const bound = this.meshBounds.get(m.meshId) ?? 1;
      const r = bound * Math.max(t.scale.x, t.scale.y, t.scale.z);
      if (!sphereInsideShadow(fit.matrix, t.position, r, fit.radius, fit.depthRange)) continue;
      casters.push({ t, meshId: m.meshId });
    }

    sm.beginPass();
    gl.enable(gl.DEPTH_TEST);
    // Front-face culling: for closed geometry the stored depth is the far
    // surface, which is what makes one compare enough against acne.
    gl.cullFace(gl.FRONT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.4, 3.0);

    // Instanced first (one VAO per mesh; attributes match INST_VERT_SRC).
    const byMesh = new Map<string, { t: Transform; meshId: string }[]>();
    for (const c of casters) {
      const list = byMesh.get(c.meshId);
      if (list) list.push(c);
      else byMesh.set(c.meshId, [c]);
    }
    gl.useProgram(this.shadowInstProgram);
    gl.uniformMatrix4fv(this.siloc.uView, false, fit.view.elements);
    gl.uniformMatrix4fv(this.siloc.uProj, false, fit.proj.elements);
    for (const [meshId, items] of byMesh) {
      if (items.length < MIN_INSTANCES) continue;
      let batch = this.instanced.get(meshId);
      if (!batch) {
        batch = new InstancedMesh(gl, this.meshData.get(meshId)!);
        this.instanced.set(meshId, batch);
      }
      for (let start = 0; start < items.length; start += MAX_BATCH) {
        const chunk = items.slice(start, start + MAX_BATCH);
        for (let i = 0; i < chunk.length; i++) {
          const { t } = chunk[i];
          composeInstance(
            this.scratch, i * FLOATS_PER_INSTANCE,
            t.position.x, t.position.y, t.position.z, t.rotationY,
            t.scale.x, t.scale.y, t.scale.z
          );
        }
        batch.write(this.scratch, chunk.length);
        batch.draw(chunk.length);
        this.stats.shadowDraws++;
      }
    }

    gl.useProgram(this.shadowProgram);
    gl.uniformMatrix4fv(this.sloc.uView, false, fit.view.elements);
    gl.uniformMatrix4fv(this.sloc.uProj, false, fit.proj.elements);
    gl.uniform1f(this.sloc.uUVScale, 1);
    for (const { t, meshId } of casters) {
      if ((byMesh.get(meshId)?.length ?? 0) >= MIN_INSTANCES) continue;
      const model = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
      gl.uniformMatrix4fv(this.sloc.uModel, false, model.elements);
      this.meshes.get(meshId)!.draw();
      this.stats.shadowDraws++;
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.cullFace(gl.BACK);
    sm.endPass();
    this.shadowActive = true;
  }

  frame(world: World) {
    const gl = this.gl;
    this.resize();
    this.stats.total = 0;
    this.stats.drawn = 0;
    this.stats.culled = 0;
    this.stats.instancedDraws = 0;
    this.stats.regularDraws = 0;
    this.stats.postDraws = 0;
    this.stats.fxDraws = 0;
    this.stats.shadowDraws = 0;
    this.stats.lodDraws = 0;
    this.stats.lodCulled = 0;
    // Shadow pass first, while the default framebuffer is still bound.
    if (this.shadows.enabled && this.lightIntensity > 0.01) {
      this.drawShadowPass(world);
    } else {
      this.shadowActive = false;
      this.shadowFit = null;
    }
    const usePost = this.post.enabled && this.post.count > 0;
    if (usePost) this.bindSceneTarget();
    else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const view = this.camera.view();
    const proj = this.camera.projection(aspect);
    const planes: Plane[] = frustumFromVP(proj.clone().multiply(view));

    // Gather visible entities (bounding sphere vs frustum).
    // PBR-material and terrain entities bypass batching (own programs).
    const visible: (VisibleItem & { meshId: string; textureId?: string; entity: Entity })[] = [];
    const skinned: { e: Entity; t: Transform; m: MeshRef }[] = [];
    const pbrItems: { t: Transform; m: MeshRef; mat: PBRMaterial }[] = [];
    const terrainItems: { t: Transform; m: MeshRef; tm: TerrainMaterial }[] = [];
    for (const e of world.query("transform", "mesh") as Entity[]) {
      this.stats.total++;
      const t = world.get<Transform>(e, "transform")!;
      const meshRef = world.get<MeshRef>(e, "mesh")!;
      const m = meshRef;
      const isSkinned = this.skinned.has(m.meshId);
      if (!isSkinned && !this.meshes.has(m.meshId)) continue;
      const bound = isSkinned
        ? this.skinned.boundsRadiusOf(m.meshId)
        : (this.meshBounds.get(m.meshId) ?? 1);
      const r = bound * Math.max(t.scale.x, t.scale.y, t.scale.z);
      if (!testSphere(planes, t.position.x, t.position.y, t.position.z, r)) {
        this.stats.culled++;
        continue;
      }
      if (isSkinned) {
        skinned.push({ e, t, m });
        continue;
      }
      if (m.terrain) {
        terrainItems.push({ t, m, tm: m.terrain });
        continue;
      }
      // LOD (Phase 2): swap in the level that matches the screen coverage.
      // Unknown level meshes fall back to the entity's own mesh.
      let drawMesh = m.meshId;
      if (m.lod && m.lod.length > 1) {
        const chain: LODLevel[] = m.lod;
        const pick = this.lod.resolve(e, chain, bound, t.scale, this.camera.position, t.position, this.camera.fovY);
        if (pick === null) {
          this.stats.culled++;
          this.stats.lodCulled++;
          continue;
        }
        if (pick.meshId !== m.meshId) {
          if (this.meshes.has(pick.meshId)) drawMesh = pick.meshId;
          this.stats.lodDraws++;
        }
      }
      const mat = resolveMaterial(m, this.materials);
      if (mat) pbrItems.push({ t, m, mat });
      else visible.push({ t, m, meshId: drawMesh, textureId: m.textureId, entity: e });
    }

    const groups = groupInstances(visible);
    gl.useProgram(this.program);
    this.uploadShared(this.loc, view, proj);
    for (const [, items] of groups) {
      if (items.length >= MIN_INSTANCES) {
        this.drawBatch(items[0].meshId, items[0].textureId, items);
        gl.useProgram(this.program);
        this.uploadShared(this.loc, view, proj);
      } else {
        for (const { t, m } of items) this.drawSingle(t, m);
      }
    }
    for (const { e, t, m } of skinned) {
      if (!this.drawSkinned(e, t, m, view, proj)) {
        // No palette available (no animator): hold the rest pose rather than
        // leaving the entity invisible.
        this.drawSingle(t, m);
      }
      gl.useProgram(this.program);
      this.uploadShared(this.loc, view, proj);
    }
    for (const { t, m, mat } of pbrItems) this.drawPBR(t, m, mat, view, proj);
    for (const { t, m, tm } of terrainItems) this.drawTerrain(t, m, tm, view, proj);
    if (this.post.enabled && this.post.count > 0) this.compositePost();
  }

  // Scene capture target (sized to the canvas; rebuilt on resize).
  private bindSceneTarget() {
    const gl = this.gl;
    const w = Math.max(1, this.canvas.width), h = Math.max(1, this.canvas.height);
    if (!this.sceneFB || !this.sceneTex || !this.sceneDepth || w !== this.postW || h !== this.postH) {
      this.deleteSceneTarget();
      this.sceneTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.sceneDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      this.sceneFB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.sceneDepth);
      this.postW = w;
      this.postH = h;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFB);
    }
    gl.viewport(0, 0, w, h);
  }

  private deleteSceneTarget() {
    const gl = this.gl;
    if (this.sceneFB) gl.deleteFramebuffer(this.sceneFB);
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.sceneDepth) gl.deleteRenderbuffer(this.sceneDepth);
    this.sceneFB = null;
    this.sceneTex = null;
    this.sceneDepth = null;
    this.postW = 0;
    this.postH = 0;
  }

  // Fullscreen composite of the captured scene through the post chain.
  private compositePost() {
    const gl = this.gl;
    if (!this.sceneTex) return;
    // Offscreen passes run first, ping-ponging between two targets.
    let source = this.sceneTex;
    const resolved = this.post.resolve();
    const offscreen = resolved.filter((p) => p.offscreen);
    if (offscreen.length > 0) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.fxProgram);
      for (const p of offscreen) {
        this.ensureFxTarget();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fxFB);
        gl.viewport(0, 0, this.fxW, this.fxH);
        this.bindTex(source, 0);
        gl.uniform1i(this.fxloc.uScene, 0);
        gl.uniform2f(this.fxloc.uTexel, 1 / this.fxW, 1 / this.fxH);
        gl.uniform1i(this.fxloc.uMode, FX_MODE[p.kind]);
        const o = p.options.opts as unknown as Record<string, number>;
        gl.uniform1f(this.fxloc.uRadius, o.radius ?? 1);
        gl.uniform1f(this.fxloc.uTaps, o.taps ?? 5);
        gl.uniform1f(this.fxloc.uThreshold, p.kind === "grain" ? o.amount : (o.threshold ?? 0));
        gl.uniform1f(this.fxloc.uIntensity, p.kind === "ao" ? o.strength : p.kind === "sharpen" ? o.amount : (o.intensity ?? 1));
        gl.uniform1f(this.fxloc.uSeed, o.seed ?? 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.stats.fxDraws++;
        source = this.fxTex!;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.postProgram);
    const u = this.post.uniforms();
    this.bindTex(source, 0);
    gl.uniform1i(this.postloc.uScene, 0);
    gl.uniform1f(this.postloc.uExposure, u.exposure);
    gl.uniform1f(this.postloc.uContrast, u.contrast);
    gl.uniform1f(this.postloc.uSaturation, u.saturation);
    gl.uniform1f(this.postloc.uTemperature, u.temperature);
    gl.uniform1f(this.postloc.uVignette, u.vignette);
    gl.uniform1f(this.postloc.uVignetteSoft, u.vignetteSoftness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    this.stats.postDraws++;
  }

  private bindTex(tex: WebGLTexture, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** Second (ping-pong) target for offscreen post passes. */
  private ensureFxTarget(): void {
    const gl = this.gl;
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    if (this.fxFB && this.fxTex && w === this.fxW && h === this.fxH) return;
    if (this.fxFB) gl.deleteFramebuffer(this.fxFB);
    if (this.fxTex) gl.deleteTexture(this.fxTex);
    this.fxW = w;
    this.fxH = h;
    this.fxTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fxFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fxFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fxTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
