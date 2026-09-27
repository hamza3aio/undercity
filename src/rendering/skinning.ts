// Glitch skinned mesh GPU resource + registry. Mesh data is built by
// anim/skeleton.ts (buildSkinMesh) and uploaded here; the renderer looks
// meshes up by id like any other mesh, so skinned and static entities share
// the same draw list (a skinned entity simply never batches).

import { buildSkinMesh, type SkinMesh, type SkinVertex } from "../anim/skeleton.js";

export const MAX_BONES_PER_PALETTE = 32; // must match uPalette[32] in the shader

export class SkinnedGpuMesh {
  vao: WebGLVertexArrayObject | null = null;
  count = 0;
  private jointBuf: WebGLBuffer | null = null;
  private weightBuf: WebGLBuffer | null = null;

  constructor(private gl: WebGL2RenderingContext, data: SkinMesh) {
    const glc = this.gl;
    this.vao = glc.createVertexArray();
    glc.bindVertexArray(this.vao);

    const stat = (location: number, size: number, arr: Float32Array) => {
      const buf = glc.createBuffer();
      glc.bindBuffer(glc.ARRAY_BUFFER, buf);
      glc.bufferData(glc.ARRAY_BUFFER, arr, glc.STATIC_DRAW);
      glc.enableVertexAttribArray(location);
      glc.vertexAttribPointer(location, size, glc.FLOAT, false, 0, 0);
    };
    stat(0, 3, data.positions);
    stat(1, 3, data.normals);
    stat(2, 2, data.uvs);

    this.jointBuf = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, this.jointBuf);
    glc.bufferData(glc.ARRAY_BUFFER, data.joints, glc.STATIC_DRAW);
    glc.enableVertexAttribArray(9);
    glc.vertexAttribPointer(9, 4, glc.FLOAT, false, 0, 0);

    this.weightBuf = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, this.weightBuf);
    glc.bufferData(glc.ARRAY_BUFFER, data.weights, glc.STATIC_DRAW);
    glc.enableVertexAttribArray(10);
    glc.vertexAttribPointer(10, 4, glc.FLOAT, false, 0, 0);

    const ibo = glc.createBuffer();
    glc.bindBuffer(glc.ELEMENT_ARRAY_BUFFER, ibo);
    glc.bufferData(glc.ELEMENT_ARRAY_BUFFER, data.indices, glc.STATIC_DRAW);
    this.count = data.indices.length;
    glc.bindVertexArray(null);
  }

  draw(): void {
    const glc = this.gl;
    glc.bindVertexArray(this.vao);
    glc.drawElements(glc.TRIANGLES, this.count, glc.UNSIGNED_SHORT, 0);
  }

  dispose(): void {
    const glc = this.gl;
    glc.deleteVertexArray(this.vao);
    if (this.jointBuf) glc.deleteBuffer(this.jointBuf);
    if (this.weightBuf) glc.deleteBuffer(this.weightBuf);
    this.vao = null;
  }
}

/** Registry of skinned meshes, keyed by the same string ids as mesh data. */
export class SkinnedMeshRegistry {
  private meshes = new Map<string, SkinnedGpuMesh>();
  private radii = new Map<string, number>();

  constructor(private gl: WebGL2RenderingContext) {}

  has(id: string): boolean {
    return this.meshes.has(id);
  }

  get(id: string): SkinnedGpuMesh | undefined {
    return this.meshes.get(id);
  }

  /** Bounding-sphere radius in mesh space, for culling. */
  boundsRadiusOf(id: string): number {
    return this.radii.get(id) ?? 1;
  }

  register(id: string, verts: SkinVertex[], indices: number[]): void {
    const data = buildSkinMesh(verts, indices);
    const existing = this.meshes.get(id);
    if (existing) existing.dispose();
    this.meshes.set(id, new SkinnedGpuMesh(this.gl, data));
    let max = 0;
    for (let i = 0; i < data.positions.length; i += 3) {
      max = Math.max(max, Math.hypot(data.positions[i], data.positions[i + 1], data.positions[i + 2]));
    }
    this.radii.set(id, max || 1);
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.dispose();
    this.meshes.clear();
    this.radii.clear();
  }
}

/**
 * A box-shaped limb column skinned to one bone (optionally leaning on a
 * child bone at the top ring, so it bends at the joint). Uses 8 shared
 * corner vertices with outward normals - fine for thin limbs (slightly
 * rounded corners); use buildSkinMesh directly for per-face normals.
 * `w`/`h` are half-extents, `zOff` shifts along the bone's forward axis so
 * rotation happens at the joint.
 */
export function limbColumn(
  joint: number, w: number, h: number, zOff = 0, secondJoint = -1, blend = 0
): { verts: SkinVertex[]; indices: number[] } {
  const corners: [number, number, number][] = [
    [-w, -h, zOff], [w, -h, zOff], [-w, h, zOff], [w, h, zOff],
    [-w, -h, zOff], [w, -h, zOff], [-w, h, zOff], [w, h, zOff],
  ];
  const verts: SkinVertex[] = corners.map(([x, y, z], i) => {
    const top = i >= 4;
    const j = secondJoint >= 0 ? (top ? secondJoint : joint) : joint;
    const wj = secondJoint >= 0 ? (top ? blend : 1 - blend) : 1;
    const len = Math.hypot(x, y) || 1;
    return {
      position: [x, y, z],
      joints: [j, j, j, j],
      weights: [wj, 0, 0, 0],
      normal: [x / len, y / len, 0],
      uv: [i & 1, top ? 1 : 0],
    };
  });
  // Standard box winding over the 8 corners (bottom ring 0-3, top ring 4-7).
  const indices = [
    0, 2, 1, 1, 2, 3, // -Z
    4, 5, 6, 5, 7, 6, // +Z
    0, 1, 4, 1, 5, 4, // -Y
    2, 6, 3, 3, 6, 7, // +Y
    0, 4, 2, 2, 4, 6, // -X
    1, 3, 5, 3, 7, 5, // +X
  ];
  return { verts, indices };
}
