import { Mat4 } from "../math/mat4.js";
import { Vec3 } from "../math/vec3.js";
import { FRAG_SRC, VERT_SRC, INST_FRAG_SRC, INST_VERT_SRC, PBR_FRAG_SRC, TERRAIN_FRAG_SRC, createProgram } from "./shader.js";
import { GpuMesh, boundsRadius, cubeData, planeData, type MeshData } from "./mesh.js";
import { Texture2D } from "./texture.js";
import { MaterialDB, resolveMaterial, type PBRMaterial } from "./materials.js";
import { frustumFromVP, testSphere, type Plane } from "./frustum.js";
import { InstancedMesh, FLOATS_PER_INSTANCE, MAX_BATCH, MIN_INSTANCES, composeInstance, groupInstances } from "./instancing.js";
import type { PointLight } from "./lights.js";
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
  textures = new Map<string, Texture2D>();
  camera = new Camera();
  lightDir = new Vec3(-0.5, -1, -0.3);
  lightIntensity = 1.0;
  pointLights: PointLight[] = [];
  clearColor: [number, number, number] = [0.07, 0.09, 0.14];
  fogColor: [number, number, number] = [0.05, 0.06, 0.1];
  fogNear = 40;
  fogFar = 200;
  skyColor: [number, number, number] = [0.5, 0.6, 0.75];
  groundColor: [number, number, number] = [0.12, 0.1, 0.09];
  ambientStrength = 1.0;
  materials = new MaterialDB();
  readonly stats: RenderStats = { total: 0, drawn: 0, culled: 0, instancedDraws: 0, regularDraws: 0, pbrDraws: 0 };
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private iloc: Record<string, WebGLUniformLocation | null> = {};
  private ploc: Record<string, WebGLUniformLocation | null> = {};
  private tloc: Record<string, WebGLUniformLocation | null> = {};

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
    ]) {
      this.loc[name] = gl.getUniformLocation(this.program, name);
    }
    this.instProgram = createProgram(gl, INST_VERT_SRC, INST_FRAG_SRC);
    for (const name of [
      "uView", "uProj", "uLightDir", "uLightIntensity",
      "uCamPos", "uMap", "uUseTexture",
      "uPointCount", "uPointPos", "uPointColor",
      "uFogColor", "uFogNear", "uFogFar",
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
    ]) {
      this.tloc[name] = gl.getUniformLocation(this.terrainProgram, name);
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
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr) || Math.floor(window.innerWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr) || Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private uploadShared(loc: Record<string, WebGLUniformLocation | null>, view: Mat4, proj: Mat4) {
    const gl = this.gl;
    gl.uniformMatrix4fv(loc.uView, false, view.elements);
    gl.uniformMatrix4fv(loc.uProj, false, proj.elements);
    gl.uniform3fv(loc.uLightDir, this.lightDir.toArray() as unknown as Float32List);
    gl.uniform1f(loc.uLightIntensity, this.lightIntensity);
    gl.uniform3fv(loc.uCamPos, this.camera.position.toArray() as unknown as Float32List);
    gl.uniform1i(loc.uMap, 0);
    gl.uniform3fv(loc.uFogColor, this.fogColor as unknown as Float32List);
    gl.uniform1f(loc.uFogNear, this.fogNear);
    gl.uniform1f(loc.uFogFar, this.fogFar);
    const count = Math.min(4, this.pointLights.length);
    gl.uniform1i(loc.uPointCount, count);
    if (count > 0) {
      const posArr = new Float32Array(12);
      const colArr = new Float32Array(12);
      for (let i = 0; i < count; i++) {
        const pl = this.pointLights[i];
        posArr[i * 3] = pl.position.x; posArr[i * 3 + 1] = pl.position.y; posArr[i * 3 + 2] = pl.position.z;
        colArr[i * 3] = pl.color[0] * pl.intensity; colArr[i * 3 + 1] = pl.color[1] * pl.intensity; colArr[i * 3 + 2] = pl.color[2] * pl.intensity;
      }
      gl.uniform3fv(loc.uPointPos, posArr as unknown as Float32List);
      gl.uniform3fv(loc.uPointColor, colArr as unknown as Float32List);
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

  frame(world: World) {
    const gl = this.gl;
    this.resize();
    this.stats.total = 0;
    this.stats.drawn = 0;
    this.stats.culled = 0;
    this.stats.instancedDraws = 0;
    this.stats.regularDraws = 0;
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const view = this.camera.view();
    const proj = this.camera.projection(aspect);
    const planes: Plane[] = frustumFromVP(proj.clone().multiply(view));

    // Gather visible entities (bounding sphere vs frustum).
    // PBR-material and terrain entities bypass batching (own programs).
    const visible: (VisibleItem & { meshId: string; textureId?: string })[] = [];
    const pbrItems: { t: Transform; m: MeshRef; mat: PBRMaterial }[] = [];
    const terrainItems: { t: Transform; m: MeshRef; tm: TerrainMaterial }[] = [];
    for (const e of world.query("transform", "mesh") as Entity[]) {
      this.stats.total++;
      const t = world.get<Transform>(e, "transform")!;
      const m = world.get<MeshRef>(e, "mesh")!;
      if (!this.meshes.has(m.meshId)) continue;
      const bound = this.meshBounds.get(m.meshId) ?? 1;
      const r = bound * Math.max(t.scale.x, t.scale.y, t.scale.z);
      if (!testSphere(planes, t.position.x, t.position.y, t.position.z, r)) {
        this.stats.culled++;
        continue;
      }
      if (m.terrain) {
        terrainItems.push({ t, m, tm: m.terrain });
        continue;
      }
      const mat = resolveMaterial(m, this.materials);
      if (mat) pbrItems.push({ t, m, mat });
      else visible.push({ t, m, meshId: m.meshId, textureId: m.textureId });
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
    for (const { t, m, mat } of pbrItems) this.drawPBR(t, m, mat, view, proj);
    for (const { t, m, tm } of terrainItems) this.drawTerrain(t, m, tm, view, proj);
  }
}
