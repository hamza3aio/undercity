// Cube: 24 verts (per-face normals+uvs), 36 indices. Plane: 4 verts, 6 indices.
export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

// Rotation-proof bounding radius: max |position| over vertices.
// Doubles as the frustum-culling sphere radius (times max entity scale).
export function boundsRadius(data: MeshData): number {
  let max = 0;
  const p = data.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const r = Math.hypot(p[i], p[i + 1], p[i + 2]);
    if (r > max) max = r;
  }
  return max;
}

export function cubeData(size = 1): MeshData {
  const h = size / 2;
  const faces: { dir: number[]; corners: number[][] }[] = [
    { dir: [0, 0, 1], corners: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
    { dir: [0, 0, -1], corners: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] },
    { dir: [1, 0, 0], corners: [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] },
    { dir: [-1, 0, 0], corners: [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] },
    { dir: [0, 1, 0], corners: [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] },
    { dir: [0, -1, 0], corners: [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const faceUV = [0, 0, 1, 0, 1, 1, 0, 1];
  faces.forEach((f, fi) => {
    const base = fi * 4;
    for (const c of f.corners) positions.push(...c);
    for (let i = 0; i < 4; i++) normals.push(...f.dir);
    uvs.push(...faceUV);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

export function planeData(size = 20): MeshData {
  const h = size / 2;
  const rep = size / 5; // tile texture every 5 units
  return {
    positions: new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, rep, 0, rep, rep, 0, rep]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

export class GpuMesh {
  vao: WebGLVertexArrayObject | null = null;
  count = 0;

  constructor(private gl: WebGL2RenderingContext, data: MeshData) {
    const glc = this.gl;
    this.vao = glc.createVertexArray();
    glc.bindVertexArray(this.vao);

    const vbo = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, vbo);
    glc.bufferData(glc.ARRAY_BUFFER, data.positions, glc.STATIC_DRAW);
    glc.enableVertexAttribArray(0);
    glc.vertexAttribPointer(0, 3, glc.FLOAT, false, 0, 0);

    const nbo = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, nbo);
    glc.bufferData(glc.ARRAY_BUFFER, data.normals, glc.STATIC_DRAW);
    glc.enableVertexAttribArray(1);
    glc.vertexAttribPointer(1, 3, glc.FLOAT, false, 0, 0);

    const uvo = glc.createBuffer();
    glc.bindBuffer(glc.ARRAY_BUFFER, uvo);
    glc.bufferData(glc.ARRAY_BUFFER, data.uvs, glc.STATIC_DRAW);
    glc.enableVertexAttribArray(2);
    glc.vertexAttribPointer(2, 2, glc.FLOAT, false, 0, 0);

    const ibo = glc.createBuffer();
    glc.bindBuffer(glc.ELEMENT_ARRAY_BUFFER, ibo);
    glc.bufferData(glc.ELEMENT_ARRAY_BUFFER, data.indices, glc.STATIC_DRAW);

    this.count = data.indices.length;
    glc.bindVertexArray(null);
  }

  draw() {
    const glc = this.gl;
    glc.bindVertexArray(this.vao);
    glc.drawElements(glc.TRIANGLES, this.count, glc.UNSIGNED_SHORT, 0);
  }
}
