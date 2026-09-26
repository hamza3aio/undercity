// Glitch instancing — CPU batching logic (headless-testable) plus one small
// GL batch renderer. Entities sharing meshId+textureId and passing the
// MIN_INSTANCES threshold draw in a single drawElementsInstanced call.
// Rule: the single-draw path is never touched by this module.

import type { MeshData } from "./mesh.js";

export const MIN_INSTANCES = 4;
export const FLOATS_PER_INSTANCE = 16 + 3 + 2; // model mat4 + color + (uvScale, shininess)
export const MAX_BATCH = 2048;

export interface InstanceItem {
  meshId: string;
  textureId?: string;
}

export function groupKey(meshId: string, textureId?: string): string {
  return `${meshId}\n${textureId ?? ""}`;
}

export function groupInstances<T extends InstanceItem>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = groupKey(item.meshId, item.textureId);
    let list = out.get(key);
    if (!list) {
      list = [];
      out.set(key, list);
    }
    list.push(item);
  }
  return out;
}

// Column-major T * RotY * S into out[offset..offset+15]. Matches Mat4
// translate().rotateY().scale() exactly (verified in tests/render.test.ts).
export function composeInstance(
  out: Float32Array,
  offset: number,
  px: number, py: number, pz: number,
  ry: number,
  sx: number, sy: number, sz: number
): void {
  const c = Math.cos(ry), s = Math.sin(ry);
  out[offset] = c * sx; out[offset + 1] = 0; out[offset + 2] = -s * sx; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = sy; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = s * sz; out[offset + 9] = 0; out[offset + 10] = c * sz; out[offset + 11] = 0;
  out[offset + 12] = px; out[offset + 13] = py; out[offset + 14] = pz; out[offset + 15] = 1;
}

export class InstancedMesh {
  private vao: WebGLVertexArrayObject | null = null;
  private instanceBuf: WebGLBuffer | null = null;
  private count = 0;

  constructor(private gl: WebGL2RenderingContext, data: MeshData) {
    const glc = this.gl;
    this.vao = glc.createVertexArray();
    glc.bindVertexArray(this.vao);

    const bindStatic = (location: number, size: number, arr: Float32Array) => {
      const buf = glc.createBuffer();
      glc.bindBuffer(glc.ARRAY_BUFFER, buf);
      glc.bufferData(glc.ARRAY_BUFFER, arr, glc.STATIC_DRAW);
      glc.enableVertexAttribArray(location);
      glc.vertexAttribPointer(location, size, glc.FLOAT, false, 0, 0);
    };
    bindStatic(0, 3, data.positions);
    bindStatic(1, 3, data.normals);
    bindStatic(2, 2, data.uvs);

    const ibo = glc.createBuffer();
    glc.bindBuffer(glc.ELEMENT_ARRAY_BUFFER, ibo);
    glc.bufferData(glc.ELEMENT_ARRAY_BUFFER, data.indices, glc.STATIC_DRAW);
    this.count = data.indices.length;

    // Per-instance buffer: interleaved [mat4(16), color(3), params(2)].
    const stride = FLOATS_PER_INSTANCE * 4;
    this.instanceBuf = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, this.instanceBuf);
    glc.bufferData(glc.ARRAY_BUFFER, MAX_BATCH * stride, glc.DYNAMIC_DRAW);
    for (let i = 0; i < 4; i++) {
      const loc = 3 + i;
      glc.enableVertexAttribArray(loc);
      glc.vertexAttribPointer(loc, 4, glc.FLOAT, false, stride, i * 16);
      glc.vertexAttribDivisor(loc, 1);
    }
    glc.enableVertexAttribArray(7);
    glc.vertexAttribPointer(7, 3, glc.FLOAT, false, stride, 64);
    glc.vertexAttribDivisor(7, 1);
    glc.enableVertexAttribArray(8);
    glc.vertexAttribPointer(8, 2, glc.FLOAT, false, stride, 76);
    glc.vertexAttribDivisor(8, 1);

    glc.bindVertexArray(null);
  }

  // Upload exactly n instances from an interleaved array, then draw them.
  // Callers chunk larger groups into MAX_BATCH pieces.
  write(interleaved: Float32Array, n: number): void {
    const glc = this.gl;
    glc.bindVertexArray(this.vao);
    glc.bindBuffer(glc.ARRAY_BUFFER, this.instanceBuf);
    glc.bufferSubData(glc.ARRAY_BUFFER, 0, interleaved, 0, n * FLOATS_PER_INSTANCE);
  }

  draw(n: number): void {
    const glc = this.gl;
    glc.bindVertexArray(this.vao);
    glc.drawElementsInstanced(glc.TRIANGLES, this.count, glc.UNSIGNED_SHORT, 0, n);
  }

  dispose(): void {
    const glc = this.gl;
    glc.deleteVertexArray(this.vao);
    glc.deleteBuffer(this.instanceBuf);
    this.vao = null;
    this.instanceBuf = null;
  }
}
