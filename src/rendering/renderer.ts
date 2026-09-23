import { Mat4 } from "../math/mat4.js";
import { Vec3 } from "../math/vec3.js";
import { FRAG_SRC, VERT_SRC, createProgram } from "./shader.js";
import { GpuMesh, cubeData, planeData, type MeshData } from "./mesh.js";
import { Texture2D } from "./texture.js";
import type { PointLight } from "./lights.js";
import type { Entity } from "../ecs/world.js";
import { World } from "../ecs/world.js";
import type { MeshRef, Transform } from "../ecs/components.js";
import { Camera } from "./camera.js";

export class Renderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private meshes = new Map<string, GpuMesh>();
  textures = new Map<string, Texture2D>();
  camera = new Camera();
  lightDir = new Vec3(-0.5, -1, -0.3);
  lightIntensity = 1.0;
  pointLights: PointLight[] = [];
  clearColor: [number, number, number] = [0.07, 0.09, 0.14];
  fogColor: [number, number, number] = [0.05, 0.06, 0.1];
  fogNear = 40;
  fogFar = 200;
  private loc: Record<string, WebGLUniformLocation | null> = {};

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
    this.meshes.set("cube", new GpuMesh(gl, cubeData(1)));
    this.meshes.set("ground", new GpuMesh(gl, planeData(140)));
    this.textures.set("white", Texture2D.white(gl));
    this.textures.set("checker", Texture2D.checker(gl));
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  registerMesh(id: string, data: MeshData) {
    this.meshes.set(id, new GpuMesh(this.gl, data));
  }

  registerTexture(id: string, tex: Texture2D) {
    this.textures.set(id, tex);
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

  frame(world: World) {
    const gl = this.gl;
    this.resize();
    gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const view = this.camera.view();
    const proj = this.camera.projection(aspect);
    gl.uniformMatrix4fv(this.loc.uView, false, view.elements);
    gl.uniformMatrix4fv(this.loc.uProj, false, proj.elements);
    gl.uniform3fv(this.loc.uLightDir, this.lightDir.toArray() as unknown as Float32List);
    gl.uniform1f(this.loc.uLightIntensity, this.lightIntensity);
    gl.uniform3fv(this.loc.uCamPos, this.camera.position.toArray() as unknown as Float32List);
    gl.uniform1i(this.loc.uMap, 0);
    gl.uniform3fv(this.loc.uFogColor, this.fogColor as unknown as Float32List);
    gl.uniform1f(this.loc.uFogNear, this.fogNear);
    gl.uniform1f(this.loc.uFogFar, this.fogFar);

    const count = Math.min(4, this.pointLights.length);
    gl.uniform1i(this.loc.uPointCount, count);
    if (count > 0) {
      const posArr = new Float32Array(12);
      const colArr = new Float32Array(12);
      for (let i = 0; i < count; i++) {
        const pl = this.pointLights[i];
        posArr[i * 3] = pl.position.x; posArr[i * 3 + 1] = pl.position.y; posArr[i * 3 + 2] = pl.position.z;
        colArr[i * 3] = pl.color[0] * pl.intensity; colArr[i * 3 + 1] = pl.color[1] * pl.intensity; colArr[i * 3 + 2] = pl.color[2] * pl.intensity;
      }
      gl.uniform3fv(this.loc.uPointPos, posArr as unknown as Float32List);
      gl.uniform3fv(this.loc.uPointColor, colArr as unknown as Float32List);
    }

    for (const e of world.query("transform", "mesh") as Entity[]) {
      const t = world.get<Transform>(e, "transform")!;
      const m = world.get<MeshRef>(e, "mesh")!;
      const gpu = this.meshes.get(m.meshId);
      if (!gpu) continue;
      const model = new Mat4().translate(t.position).rotateY(t.rotationY).scale(t.scale);
      gl.uniformMatrix4fv(this.loc.uModel, false, model.elements);
      gl.uniform3fv(this.loc.uColor, m.color as unknown as Float32List);
      gl.uniform1f(this.loc.uShininess, m.shininess ?? 32);
      gl.uniform1f(this.loc.uUVScale, m.uvScale ?? 1);
      const tex = (m.textureId && this.textures.get(m.textureId)) || this.textures.get("white")!;
      tex.bind(0);
      gl.uniform1i(this.loc.uUseTexture, m.textureId ? 1 : 0);
      gpu.draw();
    }
  }
}
