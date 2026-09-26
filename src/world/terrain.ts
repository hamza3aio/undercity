// Glitch terrain — heightfields with sculpting, painting and collision.
// Data is plain JSON-safe arrays (no Float32Array) so terrains round-trip
// through scene files untouched. Rendering (splat-mapped, see TERRAIN_FRAG)
// and physics (heightfield ground) consume the same Heightmap.
// Chunked streaming LOD is future work; stride-LOD + swap recipe included.

export interface Heightmap {
  size: number; // verts per side (>= 2)
  cell: number; // world units between verts (> 0)
  heights: number[]; // row-major, length size*size
}

// Splat-mapped terrain surfacing: splat texture RGB weights three detail
// textures. Lives on MeshRef.terrain (opt-in; takes its own draw path).
export interface TerrainMaterial {
  splat: string;
  detailA: string;
  detailB: string;
  detailC: string;
  detailScale: number;
}

export function createHeightmap(size: number, cell: number, fill = 0): Heightmap {
  if (!Number.isInteger(size) || size < 2) throw new Error("createHeightmap: size must be an integer >= 2");
  if (!(cell > 0)) throw new Error("createHeightmap: cell must be positive");
  return { size, cell, heights: new Array(size * size).fill(fill) };
}

export function extent(h: Heightmap): number {
  return ((h.size - 1) * h.cell) / 2; // world half-size
}

function clampGrid(h: Heightmap, i: number): number {
  return Math.max(0, Math.min(h.size - 1, i));
}

export function heightAt(h: Heightmap, i: number, j: number): number {
  return h.heights[clampGrid(h, j) * h.size + clampGrid(h, i)];
}

// Bilinear world-space sample. Clamps outside the patch.
export function sampleHeight(h: Heightmap, x: number, z: number): number {
  const g = (v: number) => v / h.cell + (h.size - 1) / 2;
  const fx = Math.max(0, Math.min(h.size - 1.001, g(x)));
  const fz = Math.max(0, Math.min(h.size - 1.001, g(z)));
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const a = heightAt(h, x0, z0), b = heightAt(h, x0 + 1, z0);
  const c = heightAt(h, x0, z0 + 1), d = heightAt(h, x0 + 1, z0 + 1);
  return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
}

// Rise over run via central differences (0 = flat).
export function slopeAt(h: Heightmap, x: number, z: number): number {
  const e = h.cell;
  const dx = (sampleHeight(h, x + e, z) - sampleHeight(h, x - e, z)) / (2 * e);
  const dz = (sampleHeight(h, x, z + e) - sampleHeight(h, x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
}

export function setHeight(h: Heightmap, i: number, j: number, v: number): void {
  if (i < 0 || j < 0 || i >= h.size || j >= h.size) return;
  h.heights[j * h.size + i] = v;
}

function brush(h: Heightmap, x: number, z: number, radius: number, fn: (i: number, j: number, fall: number) => void): void {
  if (!(radius > 0)) return;
  const ci = Math.round(x / h.cell + (h.size - 1) / 2);
  const cj = Math.round(z / h.cell + (h.size - 1) / 2);
  const cr = Math.ceil(radius / h.cell);
  for (let j = cj - cr; j <= cj + cr; j++) {
    for (let i = ci - cr; i <= ci + cr; i++) {
      if (i < 0 || j < 0 || i >= h.size || j >= h.size) continue;
      const wx = (i - (h.size - 1) / 2) * h.cell;
      const wz = (j - (h.size - 1) / 2) * h.cell;
      const d = Math.hypot(wx - x, wz - z) / radius;
      if (d > 1) continue;
      const fall = (1 - d * d) * (1 - d * d); // smoothstep-ish falloff
      fn(i, j, fall);
    }
  }
}

export function raise(h: Heightmap, x: number, z: number, radius: number, amount: number): void {
  brush(h, x, z, radius, (i, j, fall) => {
    h.heights[j * h.size + i] += amount * fall;
  });
}

export function lower(h: Heightmap, x: number, z: number, radius: number, amount: number): void {
  raise(h, x, z, radius, -amount);
}

export function flatten(h: Heightmap, x: number, z: number, radius: number, height: number): void {
  brush(h, x, z, radius, (i, j, fall) => {
    const k = j * h.size + i;
    h.heights[k] += (height - h.heights[k]) * fall;
  });
}

// Box-blur smoothing pass over a region (or the whole patch).
export function smooth(h: Heightmap, x?: number, z?: number, radius?: number): void {
  const src = [...h.heights];
  const at = (i: number, j: number) => src[clampGrid(h, j) * h.size + clampGrid(h, i)];
  const inRegion = (i: number, j: number): boolean => {
    if (x === undefined || z === undefined || radius === undefined) return true;
    const wx = (i - (h.size - 1) / 2) * h.cell;
    const wz = (j - (h.size - 1) / 2) * h.cell;
    return Math.hypot(wx - x, wz - z) <= radius;
  };
  for (let j = 0; j < h.size; j++) {
    for (let i = 0; i < h.size; i++) {
      if (!inRegion(i, j)) continue;
      h.heights[j * h.size + i] =
        (at(i, j) * 4 + at(i - 1, j) + at(i + 1, j) + at(i, j - 1) + at(i, j + 1)) / 8;
    }
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic value-noise relief (seeded; same seed, same hills).
export function addNoise(h: Heightmap, seed: number, amplitude: number, wavelength: number): void {
  if (!(wavelength > 0)) throw new Error("addNoise: wavelength must be positive");
  const rnd = mulberry32(seed);
  const grid = 8;
  const vals: number[] = [];
  for (let i = 0; i < grid * grid; i++) vals.push(rnd() * 2 - 1);
  const sample = (u: number, v: number): number => {
    const gx = (((u / wavelength) % 1) + 1) % 1 * (grid - 1);
    const gy = (((v / wavelength) % 1) + 1) % 1 * (grid - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(grid - 1, x0 + 1), y1 = Math.min(grid - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    return (
      vals[y0 * grid + x0] * (1 - fx) * (1 - fy) +
      vals[y0 * grid + x1] * fx * (1 - fy) +
      vals[y1 * grid + x0] * (1 - fx) * fy +
      vals[y1 * grid + x1] * fx * fy
    );
  };
  for (let j = 0; j < h.size; j++) {
    for (let i = 0; i < h.size; i++) {
      const wx = (i - (h.size - 1) / 2) * h.cell;
      const wz = (j - (h.size - 1) / 2) * h.cell;
      h.heights[j * h.size + i] += sample(wx, wz) * amplitude;
    }
  }
}

export interface TerrainMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

// Grid mesh, CCW-up winding. stride 2 halves resolution per side (LOD:
// build stride 1 + 2, swap meshId by camera distance in game code).
export function terrainMesh(h: Heightmap, uvRepeat = 8, stride = 1): TerrainMesh {
  const idx: number[] = [];
  for (let j = 0; j < h.size; j += stride) idx.push(j);
  if (idx[idx.length - 1] !== h.size - 1) idx.push(h.size - 1);
  const n = idx.length;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const indices: number[] = [];
  const H = (i: number, j: number) => heightAt(h, idx[i], idx[j]);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = (idx[i] - (h.size - 1) / 2) * h.cell;
      const z = (idx[j] - (h.size - 1) / 2) * h.cell;
      positions[k * 3] = x;
      positions[k * 3 + 1] = H(i, j);
      positions[k * 3 + 2] = z;
      const step = h.cell * stride;
      const nx = H(Math.max(0, i - 1), j) - H(Math.min(n - 1, i + 1), j);
      const nz = H(i, Math.max(0, j - 1)) - H(i, Math.min(n - 1, j + 1));
      const inv = 1 / Math.hypot(nx, 2 * step, nz);
      normals[k * 3] = nx * inv;
      normals[k * 3 + 1] = 2 * step * inv;
      normals[k * 3 + 2] = nz * inv;
      uvs[k * 2] = (i / (n - 1)) * uvRepeat;
      uvs[k * 2 + 1] = (j / (n - 1)) * uvRepeat;
    }
  }
  const at = (i: number, j: number) => j * n + i;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      indices.push(at(i, j), at(i + 1, j + 1), at(i + 1, j));
      indices.push(at(i, j), at(i, j + 1), at(i + 1, j + 1));
    }
  }
  return { positions, normals, uvs, indices: new Uint16Array(indices) };
}

// Scatter candidates inside a disc, filtered by slope. Deterministic per rand.
export function scatterSpots(
  h: Heightmap,
  rand: () => number,
  cx: number, cz: number, radius: number,
  count: number, maxSlope: number
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let guard = count * 40 + 40;
  while (out.length < count && guard-- > 0) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    if (Math.abs(x) > extent(h) || Math.abs(z) > extent(h)) continue;
    if (slopeAt(h, x, z) > maxSlope) continue;
    out.push({ x, z });
  }
  return out;
}

// --- splat painting (pure data; canvas upload is one thin call) ---

export interface SplatMap {
  size: number;
  data: Uint8ClampedArray; // RGB = weights for detail A/B/C
}

export function createSplat(size = 64): SplatMap {
  const data = new Uint8ClampedArray(size * size * 3);
  for (let i = 0; i < size * size; i++) data[i * 3] = 255; // all grass (A)
  return { size, data };
}

// Paint channel 0/1/2 in a disc (world coords, patch-centered like heights).
export function paintSpot(s: SplatMap, ext: number, x: number, z: number, radius: number, channel: 0 | 1 | 2): void {
  if (!(radius > 0)) return;
  const toPx = (w: number) => ((w / (2 * ext)) * 0.5 + 0.5) * s.size;
  const cx = toPx(x), cz = toPx(z);
  const cr = (radius / (2 * ext)) * s.size;
  for (let j = Math.max(0, Math.floor(cz - cr)); j <= Math.min(s.size - 1, Math.ceil(cz + cr)); j++) {
    for (let i = Math.max(0, Math.floor(cx - cr)); i <= Math.min(s.size - 1, Math.ceil(cx + cr)); i++) {
      if (Math.hypot(i - cx, j - cz) > cr) continue;
      const k = (j * s.size + i) * 3;
      s.data[k] = channel === 0 ? 255 : 0;
      s.data[k + 1] = channel === 1 ? 255 : 0;
      s.data[k + 2] = channel === 2 ? 255 : 0;
    }
  }
}

// Fill one channel from a predicate (e.g. slope-based rock); the other two
// channels are cleared so weights stay exclusive.
export function paintWhere(s: SplatMap, ext: number, channel: 0 | 1 | 2, fn: (x: number, z: number) => boolean): void {
  for (let j = 0; j < s.size; j++) {
    for (let i = 0; i < s.size; i++) {
      const x = (i / s.size - 0.5) * 2 * ext;
      const z = (j / s.size - 0.5) * 2 * ext;
      const on = fn(x, z) ? 255 : 0;
      const k = (j * s.size + i) * 3;
      s.data[k] = channel === 0 ? on : 0;
      s.data[k + 1] = channel === 1 ? on : 0;
      s.data[k + 2] = channel === 2 ? on : 0;
    }
  }
}

export function splatToCanvas(s: SplatMap): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = s.size;
  cv.height = s.size;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(s.size, s.size);
  for (let i = 0; i < s.size * s.size; i++) {
    img.data[i * 4] = s.data[i * 3];
    img.data[i * 4 + 1] = s.data[i * 3 + 1];
    img.data[i * 4 + 2] = s.data[i * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
