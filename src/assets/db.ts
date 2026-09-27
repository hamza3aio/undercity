// Glitch asset database — GUID registry, import settings, dependencies.
// Pure data + validation (no DOM/GL/fetch): AssetLoader stays the fetch
// layer, scenes/prefabs reference assets by GUID. Persisted as versioned
// JSON with migration. Engine exposes one instance as Engine.assets.

export type AssetKind = "texture" | "model" | "material" | "scene" | "audio" | "script";

export const ASSET_KINDS: AssetKind[] = ["texture", "model", "material", "scene", "audio", "script"];

export interface TextureImport {
  srgb: boolean;
  wrap: "clamp" | "repeat";
  filter: "linear" | "nearest";
  maxSize: number; // px, positive int
}

export interface ModelImport {
  scale: number; // > 0
  flipY: boolean;
}

export interface AudioImport {
  stream: boolean;
  volume: number; // 0..1
}

export type ImportSettings = TextureImport | ModelImport | AudioImport | Record<string, never>;

export interface AssetMeta {
  guid: string;
  kind: AssetKind;
  path: string;
  settings: ImportSettings;
  dependencies: string[]; // GUIDs of assets this one needs
  hash: string | null; // content hash at last import (null = never imported)
  importedAt: number; // ms epoch of last import (0 = never)
}

export const ASSET_DB_VERSION = 1;

// FNV-1a 32-bit (deterministic GUID seed; two lanes = 64 bits of entropy).
function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}

// GUIDs: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". Seeded form is stable
// (same seed, same GUID); unseeded uses crypto randomness when available.
export function makeGuid(seed?: string): string {
  if (seed !== undefined) {
    const a = hex8(fnv1a(seed, 0x811c9dc5));
    const b = hex8(fnv1a(seed, 0x01000193));
    return `${a.slice(0, 8)}-${a.slice(0, 4)}-4${a.slice(5, 8)}-8${b.slice(0, 3)}-${b}${a.slice(0, 4)}`.slice(0, 36);
  }
  const rnd = (): string => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  };
  return rnd();
}

export function isGuid(s: unknown): boolean {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

function finite(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`assetdb: ${name} must be a finite number`);
  return v;
}

export function defaultSettings(kind: AssetKind): ImportSettings {
  switch (kind) {
    case "texture": return { srgb: true, wrap: "repeat", filter: "linear", maxSize: 2048 };
    case "model": return { scale: 1, flipY: false };
    case "audio": return { stream: false, volume: 1 };
    default: return {};
  }
}

export function sanitizeSettings(kind: AssetKind, raw: unknown): ImportSettings {
  if (typeof raw !== "object" || raw === null) throw new Error("assetdb: settings must be an object");
  const s = raw as Record<string, unknown>;
  if (kind === "texture") {
    const wrap = s.wrap ?? "repeat";
    const filter = s.filter ?? "linear";
    if (wrap !== "clamp" && wrap !== "repeat") throw new Error(`assetdb: bad texture wrap "${String(wrap)}"`);
    if (filter !== "linear" && filter !== "nearest") throw new Error(`assetdb: bad texture filter "${String(filter)}"`);
    const maxSize = finite(s.maxSize ?? 2048, "maxSize");
    if (!Number.isInteger(maxSize) || maxSize <= 0) throw new Error("assetdb: maxSize must be a positive integer");
    return { srgb: s.srgb !== false, wrap, filter, maxSize };
  }
  if (kind === "model") {
    const scale = finite(s.scale ?? 1, "scale");
    if (!(scale > 0)) throw new Error("assetdb: model scale must be positive");
    return { scale, flipY: s.flipY === true };
  }
  if (kind === "audio") {
    const volume = finite(s.volume ?? 1, "volume");
    if (volume < 0 || volume > 1) throw new Error("assetdb: audio volume must be 0..1");
    return { stream: s.stream === true, volume };
  }
  return {};
}

export interface RegisterOpts {
  guid?: string;
  settings?: unknown;
  dependencies?: string[];
}

export class AssetDB {
  private assets = new Map<string, AssetMeta>();
  private byPath = new Map<string, string>(); // path -> guid

  get count(): number {
    return this.assets.size;
  }

  register(path: string, kind: AssetKind, opts: RegisterOpts = {}): string {
    if (typeof path !== "string" || path.length === 0) throw new Error("assetdb: path must be a non-empty string");
    if (!ASSET_KINDS.includes(kind)) throw new Error(`assetdb: unknown kind "${String(kind)}"`);
    if (this.byPath.has(path)) throw new Error(`assetdb: duplicate path "${path}"`);
    const guid = opts.guid ?? makeGuid();
    if (!isGuid(guid)) throw new Error(`assetdb: bad GUID "${guid}"`);
    if (this.assets.has(guid)) throw new Error(`assetdb: duplicate GUID "${guid}"`);
    const deps = opts.dependencies ?? [];
    for (const d of deps) {
      if (!this.assets.has(d)) throw new Error(`assetdb: missing dependency "${d}"`);
      if (d === guid) throw new Error("assetdb: asset cannot depend on itself");
    }
    const meta: AssetMeta = {
      guid, kind, path,
      settings: sanitizeSettings(kind, opts.settings ?? defaultSettings(kind)),
      dependencies: [...deps],
      hash: null, importedAt: 0,
    };
    this.assets.set(guid, meta);
    this.byPath.set(path, guid);
    if (this.hasCycle()) {
      this.assets.delete(guid);
      this.byPath.delete(path);
      throw new Error("assetdb: dependencies would form a cycle");
    }
    return guid;
  }

  get(guid: string): AssetMeta | undefined {
    return this.assets.get(guid);
  }

  /** All registered assets, in insertion order (optionally one kind). */
  list(kind?: AssetKind): AssetMeta[] {
    const all = [...this.assets.values()];
    return kind ? all.filter((a) => a.kind === kind) : all;
  }

  has(guid: string): boolean {
    return this.assets.has(guid);
  }

  findByPath(path: string): AssetMeta | undefined {
    const guid = this.byPath.get(path);
    return guid !== undefined ? this.assets.get(guid) : undefined;
  }

  setDependencies(guid: string, deps: string[]): void {
    const meta = this.assets.get(guid);
    if (!meta) throw new Error(`assetdb: unknown asset "${guid}"`);
    for (const d of deps) {
      if (!this.assets.has(d)) throw new Error(`assetdb: missing dependency "${d}"`);
      if (d === guid) throw new Error("assetdb: asset cannot depend on itself");
    }
    const prev = meta.dependencies;
    meta.dependencies = [...deps];
    if (this.hasCycle()) {
      meta.dependencies = prev;
      throw new Error("assetdb: dependencies would form a cycle");
    }
  }

  touch(guid: string, hash: string | null = null): boolean {
    const meta = this.assets.get(guid);
    if (!meta) return false;
    meta.hash = hash;
    meta.importedAt = Date.now();
    return true;
  }

  dependentsOf(guid: string): AssetMeta[] {
    return [...this.assets.values()].filter((a) => a.dependencies.includes(guid));
  }

  // Assets nothing depends on (entry points and strays alike).
  orphans(): AssetMeta[] {
    const needed = new Set<string>();
    for (const a of this.assets.values()) for (const d of a.dependencies) needed.add(d);
    return [...this.assets.values()].filter((a) => !needed.has(a.guid));
  }

  // Remove fails when dependents exist unless force (which prunes edges).
  remove(guid: string, force = false): boolean {
    const meta = this.assets.get(guid);
    if (!meta) return false;
    const dependents = this.dependentsOf(guid);
    if (dependents.length > 0 && !force) return false;
    if (force) {
      for (const d of dependents) d.dependencies = d.dependencies.filter((x) => x !== guid);
    }
    this.assets.delete(guid);
    this.byPath.delete(meta.path);
    return true;
  }

  clear(): void {
    this.assets.clear();
    this.byPath.clear();
  }

  // Structural health check; empty array = healthy.
  validate(): string[] {
    const issues: string[] = [];
    const seenPaths = new Map<string, string>();
    for (const a of this.assets.values()) {
      if (seenPaths.has(a.path)) issues.push(`duplicate path "${a.path}"`);
      else seenPaths.set(a.path, a.guid);
      for (const d of a.dependencies) {
        if (!this.assets.has(d)) issues.push(`"${a.path}" depends on missing "${d}"`);
        if (d === a.guid) issues.push(`"${a.path}" depends on itself`);
      }
    }
    if (this.hasCycle()) issues.push("dependency cycle detected");
    return issues;
  }

  private hasCycle(): boolean {
    const state = new Map<string, 0 | 1 | 2>(); // 0=unvisited 1=in-stack 2=done
    const visit = (guid: string): boolean => {
      const s = state.get(guid) ?? 0;
      if (s === 1) return true;
      if (s === 2) return false;
      state.set(guid, 1);
      for (const d of this.assets.get(guid)?.dependencies ?? []) {
        if (visit(d)) return true;
      }
      state.set(guid, 2);
      return false;
    };
    for (const guid of this.assets.keys()) {
      if (visit(guid)) return true;
    }
    return false;
  }

  toJSON(): { version: number; assets: AssetMeta[] } {
    return {
      version: ASSET_DB_VERSION,
      assets: [...this.assets.values()].map((a) => ({
        ...a,
        settings: { ...a.settings },
        dependencies: [...a.dependencies],
      })),
    };
  }

  static fromJSON(data: unknown): AssetDB {
    const db = new AssetDB();
    if (typeof data !== "object" || data === null) throw new Error("assetdb: JSON must be an object");
    const d = data as { version?: unknown; assets?: unknown };
    // Missing version = v0/v1-era payload: same shape, no migration needed.
    if (d.version !== undefined && d.version !== ASSET_DB_VERSION) {
      throw new Error(`assetdb: unsupported version "${String(d.version)}"`);
    }
    if (!Array.isArray(d.assets)) throw new Error("assetdb: JSON needs an assets array");
    for (const a of d.assets) {
      if (typeof a !== "object" || a === null) throw new Error("assetdb: asset must be an object");
      const m = a as { guid?: unknown; kind?: unknown; path?: unknown; settings?: unknown; dependencies?: unknown; hash?: unknown; importedAt?: unknown };
      if (!isGuid(m.guid)) throw new Error("assetdb: asset needs a valid GUID");
      if (typeof m.kind !== "string" || !ASSET_KINDS.includes(m.kind as AssetKind)) {
        throw new Error(`assetdb: unknown kind "${String(m.kind)}"`);
      }
      if (typeof m.path !== "string" || m.path.length === 0) throw new Error("assetdb: asset needs a path");
      const deps = m.dependencies ?? [];
      if (!Array.isArray(deps) || deps.some((x) => typeof x !== "string")) {
        throw new Error("assetdb: dependencies must be string array");
      }
      const guid = db.register(m.path, m.kind as AssetKind, {
        guid: m.guid as string,
        settings: m.settings ?? {},
        dependencies: [], // wired second (payload order is arbitrary)
      });
      const meta = db.get(guid)!;
      meta.hash = typeof m.hash === "string" ? m.hash : null;
      meta.importedAt = typeof m.importedAt === "number" ? m.importedAt : 0;
      // Stash requested deps for the second pass.
      (meta as { __deps?: string[] }).__deps = deps as string[];
    }
    // Second pass: order-independent dependency wiring.
    for (const meta of db.assets.values()) {
      const deps = (meta as { __deps?: string[] }).__deps ?? [];
      delete (meta as { __deps?: string[] }).__deps;
      if (deps.length > 0) db.setDependencies(meta.guid, deps);
    }
    return db;
  }
}
