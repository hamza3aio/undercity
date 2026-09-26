// Glitch navigation — baked walkability grids, A* pathfinding, smoothing.
// Grid-based (not recast-style): static box/sphere/capsule footprints plus
// terrain slope rejection, agent-radius inflation, dynamic obstacle edits.
// Pure data + math (headless-testable); agents live in agent.ts.

import { World, type Entity } from "../ecs/world.js";
import type { BoxCollider, CapsuleCollider, SphereCollider, Transform } from "../ecs/components.js";
import { sampleHeight, slopeAt } from "../world/terrain.js";
import type { TerrainCollider } from "../ecs/components.js";

export interface NavGrid {
  cols: number;
  rows: number;
  cell: number; // world units per cell
  originX: number; // world x of cell (0,0) corner
  originZ: number;
  blocked: Uint8Array; // 1 = blocked
}

export interface BakeOpts {
  minX: number; maxX: number; minZ: number; maxZ: number;
  cell: number;
  agentRadius?: number; // obstacle inflation (default 0.4)
  maxSlope?: number; // terrain slope cutoff, rise/run (default 0.6)
}

function idx(g: NavGrid, i: number, j: number): number {
  return j * g.cols + i;
}

export function cellOf(g: NavGrid, x: number, z: number): { i: number; j: number } {
  return {
    i: Math.max(0, Math.min(g.cols - 1, Math.floor((x - g.originX) / g.cell))),
    j: Math.max(0, Math.min(g.rows - 1, Math.floor((z - g.originZ) / g.cell))),
  };
}

export function cellCenter(g: NavGrid, i: number, j: number): { x: number; z: number } {
  return { x: g.originX + (i + 0.5) * g.cell, z: g.originZ + (j + 0.5) * g.cell };
}

export function isWalkableCell(g: NavGrid, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) return false;
  return g.blocked[idx(g, i, j)] === 0;
}

function disc(g: NavGrid, x: number, z: number, r: number, v: 0 | 1): void {
  const c = cellOf(g, x, z);
  const cr = Math.ceil(r / g.cell);
  for (let j = c.j - cr; j <= c.j + cr; j++) {
    for (let i = c.i - cr; i <= c.i + cr; i++) {
      if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) continue;
      const p = cellCenter(g, i, j);
      if (Math.hypot(p.x - x, p.z - z) <= r) g.blocked[idx(g, i, j)] = v;
    }
  }
}

export function bakeNavmesh(world: World, opts: BakeOpts): NavGrid {
  if (!(opts.cell > 0)) throw new Error("bakeNavmesh: cell must be positive");
  if (opts.maxX <= opts.minX || opts.maxZ <= opts.minZ) {
    throw new Error("bakeNavmesh: invalid bounds");
  }
  const cols = Math.max(1, Math.ceil((opts.maxX - opts.minX) / opts.cell));
  const rows = Math.max(1, Math.ceil((opts.maxZ - opts.minZ) / opts.cell));
  const g: NavGrid = {
    cols, rows, cell: opts.cell,
    originX: opts.minX, originZ: opts.minZ,
    blocked: new Uint8Array(cols * rows),
  };
  const inflate = opts.agentRadius ?? 0.4;
  const maxSlope = opts.maxSlope ?? 0.6;

  for (const e of world.query("transform")) {
    const t = world.get<Transform>(e, "transform")!;
    const box = world.get<BoxCollider>(e, "collider");
    if (box?.isStatic) {
      const hx = box.halfExtents.x * t.scale.x + inflate;
      const hz = box.halfExtents.z * t.scale.z + inflate;
      const c = cellOf(g, t.position.x, t.position.z);
      const crx = Math.ceil(hx / g.cell), crz = Math.ceil(hz / g.cell);
      for (let j = c.j - crz; j <= c.j + crz; j++) {
        for (let i = c.i - crx; i <= c.i + crx; i++) {
          if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) continue;
          const p = cellCenter(g, i, j);
          if (Math.abs(p.x - t.position.x) <= hx && Math.abs(p.z - t.position.z) <= hz) {
            g.blocked[idx(g, i, j)] = 1;
          }
        }
      }
      continue;
    }
    const sph = world.get<SphereCollider>(e, "sphere");
    if (sph?.isStatic) {
      const r = sph.radius * Math.max(t.scale.x, t.scale.y, t.scale.z) + inflate;
      disc(g, t.position.x, t.position.z, r, 1);
      continue;
    }
    const cap = world.get<CapsuleCollider>(e, "capsule");
    if (cap?.isStatic) {
      // A Y-axis capsule covers a ground disc of its radius.
      const r = cap.radius * Math.max(t.scale.x, t.scale.z) + inflate;
      disc(g, t.position.x, t.position.z, r, 1);
    }
  }

  // Terrain slope rejection (only where terrain entities exist).
  const terrains = world.query("transform", "terrain");
  if (terrains.length > 0) {
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        if (g.blocked[idx(g, i, j)] === 1) continue;
        const p = cellCenter(g, i, j);
        for (const te of terrains) {
          const tt = world.get<Transform>(te, "transform")!;
          const tc = world.get<TerrainCollider>(te, "terrain")!;
          const ext = ((tc.size - 1) * tc.cell) / 2;
          const lx = p.x - tt.position.x, lz = p.z - tt.position.z;
          if (Math.abs(lx) > ext || Math.abs(lz) > ext) continue;
          if (slopeAt({ size: tc.size, cell: tc.cell, heights: tc.heights }, lx, lz) > maxSlope) {
            g.blocked[idx(g, i, j)] = 1;
            break;
          }
        }
      }
    }
  }
  return g;
}

// Dynamic obstacle edit (doors, crates, parked carts). No re-bake needed.
export function setObstacle(g: NavGrid, x: number, z: number, r: number, blocked: boolean): void {
  disc(g, x, z, Math.max(0, r), blocked ? 1 : 0);
}

// --- A* ---

interface HeapItem {
  f: number;
  idx: number;
}

function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p].f <= heap[i].f) break;
    const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
    i = p;
  }
}

function heapPop(heap: HeapItem[]): HeapItem | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last !== undefined) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < heap.length && heap[l].f < heap[m].f) m = l;
      if (r < heap.length && heap[r].f < heap[m].f) m = r;
      if (m === i) break;
      const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      i = m;
    }
  }
  return top;
}

const SQRT2 = Math.SQRT2;
const DIRS: { di: number; dj: number; cost: number }[] = [
  { di: 1, dj: 0, cost: 1 }, { di: -1, dj: 0, cost: 1 },
  { di: 0, dj: 1, cost: 1 }, { di: 0, dj: -1, cost: 1 },
  { di: 1, dj: 1, cost: SQRT2 }, { di: 1, dj: -1, cost: SQRT2 },
  { di: -1, dj: 1, cost: SQRT2 }, { di: -1, dj: -1, cost: SQRT2 },
];

function octile(a: number, b: number, c: number, d: number): number {
  const dx = Math.abs(a - c), dy = Math.abs(b - d);
  return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
}

// Nearest walkable cell within a bounded spiral (null when boxed in).
function nearestWalkable(g: NavGrid, i: number, j: number, maxR = 20): { i: number; j: number } | null {
  if (isWalkableCell(g, i, j)) return { i, j };
  for (let r = 1; r <= maxR; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        if (isWalkableCell(g, i + di, j + dj)) return { i: i + di, j: j + dj };
      }
    }
  }
  return null;
}

function segmentClear(g: NavGrid, ax: number, az: number, bx: number, bz: number): boolean {
  const dist = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(dist / (g.cell * 0.5)));
  for (let s = 0; s <= steps; s++) {
    const x = ax + ((bx - ax) * s) / steps;
    const z = az + ((bz - az) * s) / steps;
    const c = cellOf(g, x, z);
    if (!isWalkableCell(g, c.i, c.j)) return false;
  }
  return true;
}

// Greedy string-pulling: skip to the furthest visible waypoint.
export function smoothPath(g: NavGrid, pts: { x: number; z: number }[]): { x: number; z: number }[] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let next = anchor + 1;
    for (let i = pts.length - 1; i > anchor + 1; i--) {
      if (segmentClear(g, pts[anchor].x, pts[anchor].z, pts[i].x, pts[i].z)) {
        next = i;
        break;
      }
    }
    out.push(pts[next]);
    anchor = next;
  }
  return out;
}

export function findPath(
  g: NavGrid,
  sx: number, sz: number, tx: number, tz: number,
  smooth = true
): { x: number; z: number }[] | null {
  const sc = cellOf(g, sx, sz);
  const tc = cellOf(g, tx, tz);
  const start = nearestWalkable(g, sc.i, sc.j);
  const goal = nearestWalkable(g, tc.i, tc.j);
  if (!start || !goal) return null;
  if (start.i === goal.i && start.j === goal.j) {
    const p = cellCenter(g, goal.i, goal.j);
    return smooth ? [p] : [p];
  }
  const n = g.cols * g.rows;
  const gScore = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const si = start.j * g.cols + start.i;
  const gi = goal.j * g.cols + goal.i;
  gScore[si] = 0;
  const heap: HeapItem[] = [];
  heapPush(heap, { f: octile(start.i, start.j, goal.i, goal.j), idx: si });
  let expansions = 0;
  const MAX_EXPANSIONS = 20000;
  while (heap.length > 0) {
    const cur = heapPop(heap)!;
    const ci = cur.idx % g.cols, cj = Math.floor(cur.idx / g.cols);
    if (closed[cur.idx] === 1) continue;
    closed[cur.idx] = 1;
    if (cur.idx === gi) break;
    if (++expansions > MAX_EXPANSIONS) return null;
    for (const d of DIRS) {
      const ni = ci + d.di, nj = cj + d.dj;
      if (!isWalkableCell(g, ni, nj)) continue;
      if (d.di !== 0 && d.dj !== 0) {
        // no corner cutting
        if (!isWalkableCell(g, ci + d.di, cj) || !isWalkableCell(g, ci, cj + d.dj)) continue;
      }
      const nidx = nj * g.cols + ni;
      const tentative = gScore[cur.idx] + d.cost;
      if (tentative < gScore[nidx]) {
        gScore[nidx] = tentative;
        came[nidx] = cur.idx;
        heapPush(heap, { f: tentative + octile(ni, nj, goal.i, goal.j), idx: nidx });
      }
    }
  }
  if (came[gi] === -1 && gi !== si) return null;
  const cells: { i: number; j: number }[] = [];
  let cur = gi;
  let guard = n + 1;
  while (cur !== -1 && guard-- > 0) {
    cells.push({ i: cur % g.cols, j: Math.floor(cur / g.cols) });
    if (cur === si) break;
    cur = came[cur];
  }
  cells.reverse();
  const pts = cells.map((c) => cellCenter(g, c.i, c.j));
  return smooth ? smoothPath(g, pts) : pts;
}
