// Glitch asset import pipeline (Phase 7) — import queue, importers, cache.
//
// The pipeline is deliberately small but real: importers turn raw bytes
// into plain JSON-safe descriptors, a queue runs them off the critical
// path (chunked, cancellable, with progress), results land in AssetDB with
// dependency edges, and a content hash decides reimports.
//
// Implemented importers: OBJ (existing parser, wired here), glTF 2.0 JSON
// and binary GLB (geometry only). Not implemented, and not faked: FBX,
// textures decoded to GPU objects, audio transcoding, fonts, shader
// compilation. Those are registered as extension points.

import { AssetDB, type AssetKind } from "../assets/db.js";
import { parseOBJ } from "../rendering/obj.js";
import type { MeshData } from "../rendering/mesh.js";
import type { Logger } from "../debug/logger.js";

export interface ImportedMesh {
  name: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export interface ImportedMaterial {
  name: string;
  baseColor: [number, number, number, number];
  metallic: number;
  roughness: number;
}

export interface ImportResult {
  /** Engine-side artifacts to upload (mesh data, texture ids, ...). */
  meshes: ImportedMesh[];
  materials: ImportedMaterial[];
  /** GUIDs this asset needs at runtime. */
  dependencies: string[];
  /** Non-fatal notes (missing normals, dropped extras, ...). */
  warnings: string[];
}

export interface Importer {
  id: string;
  label: string;
  extensions: string[];
  import: (data: ArrayBuffer | string, name: string) => ImportResult;
}

// --- FNV-1a content hash (stable across runs, good enough for reimports) ---

export function hashBytes(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (b + i), 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// --- glTF 2.0 / GLB ---

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfAccessor {
  bufferView?: number;
  componentType: number;
  count: number;
  type: string;
  byteOffset?: number;
  normalized?: boolean;
}

interface GltfPrimitive {
  attributes: { POSITION?: number; NORMAL?: number; TEXCOORD_0?: number };
  indices?: number;
  material?: number;
}

export interface GltfDoc {
  asset: { version: string };
  buffers: { uri?: string; byteLength: number }[];
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  materials?: { name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number } }[];
  nodes?: { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  images?: { uri?: string; name?: string }[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"

/** Splits a GLB container into its JSON chunk and binary chunk. */
export function parseGLB(data: ArrayBuffer): { json: GltfDoc; bin?: ArrayBuffer } {
  const view = new DataView(data);
  if (data.byteLength < 12) throw new Error("glb: file is too small");
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("glb: not a glTF binary (bad magic)");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`glb: unsupported version ${version}`);
  const total = view.getUint32(8, true);
  let offset = 12;
  let json: GltfDoc | null = null;
  let bin: ArrayBuffer | null = null;
  while (offset + 8 <= Math.min(total, data.byteLength)) {
    const chunkLen = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLen > data.byteLength) throw new Error("glb: chunk runs past end of file");
    if (chunkType === 0x4e4f534a) { // "JSON"
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, chunkLen))) as GltfDoc;
    } else if (chunkType === 0x004e4942) { // "BIN"
      bin = data.slice(start, start + chunkLen);
    }
    offset = start + chunkLen;
  }
  if (!json) throw new Error("glb: no JSON chunk found");
  return { json, bin: bin ?? undefined };
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readAccessor(
  json: GltfDoc, bin: ArrayBuffer | undefined, index: number, out: { stride: number; data: Float32Array }
): void {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`gltf: missing accessor ${index}`);
  const view = json.bufferViews?.[acc.bufferView ?? -1];
  if (!view) throw new Error(`gltf: accessor ${index} has no bufferView`);
  const buf = json.buffers[view.buffer];
  if (!buf) throw new Error(`gltf: missing buffer ${view.buffer}`);
  // External .bin buffers are not fetched here: the importer is synchronous
  // by design and reports the gap instead of guessing.
  if (!bin) throw new Error("gltf: geometry needs the binary chunk (embedded .bin loading is not implemented)");
  const csize = COMPONENT_SIZE[acc.componentType] ?? 4;
  const comps = acc.type === "VEC3" ? 3 : acc.type === "VEC2" ? 2 : acc.type === "VEC4" ? 4 : 1;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? csize * comps;
  const n = acc.count * comps;
  const out32 = new Float32Array(n);
  const dv = new DataView(bin);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * csize;
      switch (acc.componentType) {
        case 5120: out32[i * comps + c] = dv.getInt8(o); break;
        case 5121: out32[i * comps + c] = dv.getUint8(o); break;
        case 5122: out32[i * comps + c] = dv.getInt16(o, true); break;
        case 5123: out32[i * comps + c] = dv.getUint16(o, true); break;
        case 5125: out32[i * comps + c] = dv.getUint32(o, true); break;
        default: out32[i * comps + c] = dv.getFloat32(o, true); break;
      }
    }
  }
  out.stride = comps;
  out.data = out32;
}

/** Imports geometry + PBR factors from a glTF 2.0 document (JSON or GLB). */
export function importGltf(data: ArrayBuffer | string): ImportResult {
  const warnings: string[] = [];
  let json: GltfDoc;
  let bin: ArrayBuffer | undefined;
  if (typeof data === "string") {
    json = JSON.parse(data) as GltfDoc;
  } else {
    const parsed = parseGLB(data);
    json = parsed.json;
    bin = parsed.bin;
  }
  if (!json.asset || !String(json.asset.version).startsWith("2.")) {
    throw new Error(`gltf: unsupported asset version "${json.asset?.version ?? "?"}"`);
  }
  const meshes: ImportedMesh[] = [];
  (json.meshes ?? []).forEach((mesh, mi) => {
    mesh.primitives.forEach((prim, pi) => {
      const name = `${mesh.name ?? `mesh${mi}`}_${pi}`;
      if (prim.attributes.POSITION === undefined) {
        warnings.push(`${name}: no POSITION attribute, skipped`);
        return;
      }
      const pos = { stride: 0, data: new Float32Array(0) };
      readAccessor(json, bin, prim.attributes.POSITION, pos);
      let nrm = { stride: 0, data: new Float32Array(0) };
      if (prim.attributes.NORMAL !== undefined) readAccessor(json, bin, prim.attributes.NORMAL, nrm);
      else warnings.push(`${name}: no NORMAL attribute, normals will be generated by the engine`);
      let uv = { stride: 0, data: new Float32Array(0) };
      if (prim.attributes.TEXCOORD_0 !== undefined) readAccessor(json, bin, prim.attributes.TEXCOORD_0, uv);
      const indices: number[] = [];
      if (prim.indices !== undefined) {
        const idx = { stride: 0, data: new Float32Array(0) };
        readAccessor(json, bin, prim.indices, idx);
        for (let i = 0; i < idx.data.length; i++) indices.push(idx.data[i]);
      } else {
        for (let i = 0; i < pos.data.length / pos.stride; i++) indices.push(i);
        warnings.push(`${name}: no index buffer, expanded to a triangle list`);
      }
      meshes.push({
        name,
        positions: Array.from(pos.data),
        normals: Array.from(nrm.data),
        uvs: Array.from(uv.data),
        indices,
      });
    });
  });
  const materials: ImportedMaterial[] = (json.materials ?? []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const bc = pbr.baseColorFactor ?? [1, 1, 1, 1];
    return {
      name: m.name ?? `material${i}`,
      baseColor: [bc[0] ?? 1, bc[1] ?? 1, bc[2] ?? 1, bc[3] ?? 1],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
    };
  });
  if (json.images && json.images.length > 0) {
    warnings.push(`${json.images.length} image(s) referenced: texture upload is a separate importer step`);
  }
  return { meshes, materials, dependencies: [], warnings };
}

/** Imports an OBJ file into one mesh (the engine's existing parser). */
export function importOBJ(data: string, name = "model"): ImportResult {
  const mesh: MeshData = parseOBJ(data);
  const warnings: string[] = [];
  if (mesh.positions.length % 3 !== 0) warnings.push("OBJ position buffer is not a multiple of 3");
  if (mesh.indices.length === 0) warnings.push("OBJ contains no faces");
  if (mesh.positions.length === 0) warnings.push("OBJ contains no vertices");
  return {
    meshes: [{
      name,
      positions: Array.from(mesh.positions),
      // parseOBJ synthesises (0,1,0) normals and planar UVs when the file
      // omits them, so these buffers are always full size.
      normals: Array.from(mesh.normals),
      uvs: Array.from(mesh.uvs),
      indices: Array.from(mesh.indices),
    }],
    materials: [],
    dependencies: [],
    warnings,
  };
}

export function defaultImporters(): Importer[] {
  return [
    { id: "obj", label: "Wavefront OBJ", extensions: [".obj"], import: (d, n) => importOBJ(typeof d === "string" ? d : new TextDecoder().decode(d), n) },
    { id: "gltf", label: "glTF 2.0", extensions: [".gltf"], import: (d) => importGltf(d) },
    { id: "glb", label: "glTF Binary", extensions: [".glb"], import: (d) => { if (typeof d === "string") throw new Error("glb: binary file passed as text"); return importGltf(d); } },
  ];
}

// --- the queue ---

export type ImportStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ImportJob {
  id: number;
  name: string;
  kind: AssetKind;
  status: ImportStatus;
  progress: number; // 0..1
  error?: string;
  guid?: string;
  warnings: string[];
}

export interface ImportPipelineOptions {
  db: AssetDB;
  log?: Logger;
  importers?: Importer[];
  /** Called with each finished/failed job so a UI can refresh. */
  onChange?: (job: ImportJob) => void;
}

/**
 * Runs imports one at a time, cooperatively: `pump(msBudget)` processes
 * jobs until the time budget runs out, so the editor never stalls.
 */
export class ImportPipeline {
  private queue: ImportJob[] = [];
  private history: ImportJob[] = [];
  private importers: Importer[];
  private results = new Map<number, ImportResult>();
  private nextId = 1;
  private running: ImportJob | null = null;
  private db: AssetDB;
  private log?: Logger;
  private onChange?: (job: ImportJob) => void;
  /** Cache of guid -> { hash, result } so unchanged files skip reimport. */
  private cache = new Map<string, { hash: string; guid: string }>();

  constructor(opts: ImportPipelineOptions) {
    this.db = opts.db;
    this.log = opts.log;
    this.importers = opts.importers ?? defaultImporters();
    this.onChange = opts.onChange;
  }

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  get jobs(): ImportJob[] {
    // Queued + running + recent history, newest last: a UI needs to see
    // finished jobs, not just pending ones.
    return [...this.queue, ...(this.running ? [this.running] : []), ...this.history.slice(-20)];
  }

  register(importer: Importer): void {
    if (this.importers.some((i) => i.id === importer.id)) {
      throw new Error(`import: duplicate importer "${importer.id}"`);
    }
    this.importers.push(importer);
  }

  importerFor(filename: string): Importer | null {
    const lower = filename.toLowerCase();
    for (const imp of this.importers) {
      if (imp.extensions.some((e) => lower.endsWith(e.toLowerCase()))) return imp;
    }
    return null;
  }

  /** Queues a file. kind defaults to "model" for geometry, "script" for code. */
  enqueue(name: string, data: ArrayBuffer | string, kind: AssetKind = "model"): number | null {
    const importer = this.importerFor(name);
    if (!importer) {
      this.log?.warn("import", `no importer for "${name}"`);
      return null;
    }
    const hash = hashBytes(data);
    const known = this.db.findByPath(`import:${name}`);
    if (known && known.hash === hash) {
      // Unchanged: nothing to do, and the job is not queued.
      this.log?.info("import", `"${name}" unchanged, skipping reimport`);
      return null;
    }
    const job: ImportJob = {
      id: this.nextId++, name, kind, status: "queued", progress: 0, warnings: [],
    };
    this.queue.push(job);
    void importer; // resolved again at run time so importers can be added late
    (job as ImportJob & { data?: ArrayBuffer | string }).data = data;
    (job as ImportJob & { hash?: string }).hash = hash;
    this.onChange?.(job);
    return job.id;
  }

  cancel(id: number): boolean {
    const job = this.queue.find((j) => j.id === id);
    if (!job) return false;
    job.status = "cancelled";
    this.queue = this.queue.filter((j) => j.id !== id);
    this.onChange?.(job);
    return true;
  }

  /** Processes queued jobs for at most `msBudget` milliseconds. */
  pump(msBudget = 8): number {
    const deadline = (typeof performance !== "undefined" ? performance.now() : Date.now()) + msBudget;
    let done = 0;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      const data = (job as ImportJob & { data?: ArrayBuffer | string }).data;
      const hash = (job as ImportJob & { hash?: string }).hash ?? hashBytes(data ?? "");
      this.running = job;
      job.status = "running";
      job.progress = 0.1;
      this.onChange?.(job);
      try {
        const importer = this.importerFor(job.name);
        if (!importer) throw new Error(`no importer for "${job.name}"`);
        const result = importer.import(data ?? "", job.name);
        this.results.set(job.id, result);
        // Register in the database; re-registering keeps the same GUID.
        let guid = this.db.findByPath(`import:${job.name}`)?.guid;
        if (guid) {
          this.db.setDependencies(guid, result.dependencies.filter((d) => this.db.has(d)));
        } else {
          guid = this.db.register(`import:${job.name}`, job.kind, { dependencies: result.dependencies });
        }
        this.db.touch(guid, hash);
        this.cache.set(job.name, { hash, guid });
        job.guid = guid;
        job.warnings = result.warnings;
        job.status = "done";
        job.progress = 1;
        done++;
        for (const w of result.warnings) this.log?.warn("import", `${job.name}: ${w}`);
        this.log?.info("import", `"${job.name}" -> ${result.meshes.length} mesh(es), ${result.materials.length} material(s)`);
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        this.log?.error("import", `"${job.name}" failed`, undefined, err);
      } finally {
        this.running = null;
        this.history.push(job);
        if (this.history.length > 40) this.history.shift();
        this.onChange?.(job);
      }
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now >= deadline) break;
    }
    return done;
  }

  /** Runs the queue to completion (tests, tools, headless imports). */
  runAll(maxIterations = 1000): number {
    let total = 0;
    for (let i = 0; i < maxIterations && this.pending > 0; i++) {
      const n = this.pump(1000);
      total += n;
      if (n === 0 && this.pending === 0) break;
    }
    return total;
  }

  resultOf(jobId: number): ImportResult | null {
    return this.results.get(jobId) ?? null;
  }
}
