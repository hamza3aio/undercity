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

/**
 * Four-sided pyramid, apex at +Y (base at y = 0). Five vertices, four flat
 * faces. Used as a mid-detail stand-in for a boxy object.
 */
export function pyramidData(base = 1, height = 1): MeshData {
  const b = base / 2;
  const apex = [0, height, 0];
  // base corners, counter-clockwise seen from above
  const corners: [number, number, number][] = [
    [-b, 0, -b],
    [b, 0, -b],
    [b, 0, b],
    [-b, 0, b],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const sides: [[number, number, number], [number, number, number]][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  for (const [c0, c1] of sides) {
    const base = positions.length / 3;
    for (const c of [c0, c1, apex]) positions.push(...c);
    // Flat face normal from the winding.
    const e1 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
    const e2 = [apex[0] - c0[0], apex[1] - c0[1], apex[2] - c0[2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let i = 0; i < 3; i++) normals.push(n[0] / len, n[1] / len, n[2] / len);
    uvs.push(0, 0, 1, 0, 0.5, 1);
    indices.push(base, base + 1, base + 2);
  }
  // bottom (kept so closed props do not show through)
  const bottom = positions.length / 3;
  for (const c of [corners[3], corners[2], corners[1], corners[0]]) positions.push(...c);
  for (let i = 0; i < 4; i++) normals.push(0, -1, 0);
  uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  indices.push(bottom, bottom + 1, bottom + 2, bottom, bottom + 2, bottom + 3);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/**
 * Low-poly UV sphere. `rings` is the number of latitude bands (>= 2),
 * `segments` the number of longitude slices (>= 3). This is the usual
 * distant stand-in for organic shapes (foliage, rocks, debris).
 */
export function sphereData(radius = 0.5, rings = 4, segments = 6): MeshData {
  // At least one latitude band and three slices, or the index buffer would
  // point past the vertex buffer.
  const r = Math.max(1, Math.round(rings));
  const s = Math.max(3, Math.round(segments));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= r; i++) {
    const phi = (i / r) * Math.PI;
    const y = Math.cos(phi);
    const ring = Math.sin(phi);
    for (let j = 0; j <= s; j++) {
      const theta = (j / s) * Math.PI * 2;
      const x = ring * Math.cos(theta);
      const z = ring * Math.sin(theta);
      positions.push(x * radius, y * radius, z * radius);
      // Poles: use the axis so the normal is never zero-length.
      const nl = Math.hypot(x, y, z) || 1;
      normals.push(x / nl, y / nl, z / nl);
      uvs.push(j / s, 1 - i / r);
    }
  }
  const row = s + 1;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < s; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
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
