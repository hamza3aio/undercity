import type { MeshData } from "./mesh.js";

// Minimal OBJ parser: supports `v`, `vn`, `f` (triangulated fans). Ignores vt/uv, groups, materials.
// Generates planar UVs from x/z so textured shader still works.
export function parseOBJ(text: string): MeshData {
  const positions: number[][] = [];
  const normals: number[][] = [];
  const outPos: number[] = [];
  const outNorm: number[] = [];
  const outUV: number[] = [];
  const outIdx: number[] = [];
  const vertCache = new Map<string, number>();

  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.split(/\s+/);
      positions.push([parseFloat(x), parseFloat(y), parseFloat(z)]);
    } else if (line.startsWith("vn ")) {
      const [, x, y, z] = line.split(/\s+/);
      normals.push([parseFloat(x), parseFloat(y), parseFloat(z)]);
    } else if (line.startsWith("f ")) {
      const verts = line.slice(2).trim().split(/\s+/);
      for (let i = 1; i < verts.length - 1; i++) {
        for (const v of [verts[0], verts[i], verts[i + 1]]) {
          let idx = vertCache.get(v);
          if (idx === undefined) {
            const [vi, , ni] = v.split("/").map((s) => (s === "" ? 0 : parseInt(s, 10)));
            const p = positions[(vi || 1) - 1] ?? [0, 0, 0];
            const n = normals[(ni || 0) - 1] ?? [0, 1, 0];
            idx = outPos.length / 3;
            outPos.push(...p);
            outNorm.push(...n);
            outUV.push(p[0] * 0.5 + 0.5, p[2] * 0.5 + 0.5);
            vertCache.set(v, idx);
          }
          outIdx.push(idx);
        }
      }
    }
  }

  return {
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNorm.length ? outNorm : outPos.map((_, i) => (i % 3 === 1 ? 1 : 0))),
    uvs: new Float32Array(outUV.length ? outUV : outPos.filter((_, i) => i % 3 !== 1)),
    indices: new Uint16Array(outIdx),
  };
}
