// Glitch plugin system (Phase 22) — manifest schema, dependency ordering,
// typed extension registries and an isolated host.
//
// What a plugin can add: components, systems, editor panels, importers,
// tools (commands), shaders, scripts and assets. Everything is data or a
// function; nothing here reaches into engine internals, so a bad plugin
// fails in its own registry instead of corrupting the game.
//
// The pure half (manifest validation, topological ordering with cycle
// detection, registries, load/unload bookkeeping) is headless-testable.
// Plugin *code* loading needs a host: bundled plugins are passed in as
// modules, and on the desktop the Electron bridge can also read plugin
// folders from disk (see electron/main.cjs "glitch:read-plugins").

import type { World } from "../ecs/world.js";

export const PLUGIN_MANIFEST_VERSION = 1;

export type ExtensionKind =
  | "component"
  | "system"
  | "editorPanel"
  | "importer"
  | "tool"
  | "shader"
  | "script"
  | "asset";

export const EXTENSION_KINDS: ExtensionKind[] = [
  "component", "system", "editorPanel", "importer", "tool", "shader", "script", "asset",
];

export interface PluginManifest {
  manifestVersion: number;
  name: string;
  version: string;
  description?: string;
  /** Names of other plugins that must load first. */
  dependsOn: string[];
  /** Extensions the plugin provides, as { kind, id }. */
  provides: { kind: ExtensionKind; id: string }[];
  /** Entry module path relative to the plugin folder (desktop only). */
  entry?: string;
}

export interface ExtensionRecord {
  kind: ExtensionKind;
  id: string;
  plugin: string;
  value: unknown;
}

function str(v: unknown): boolean {
  return typeof v === "string" && v.length > 0;
}

/**
 * Validates a manifest. Throws with a precise message - a plugin author
 * needs to know exactly which field is wrong.
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (typeof raw !== "object" || raw === null) throw new Error("plugin: manifest must be an object");
  const m = raw as Record<string, unknown>;
  const version = m.manifestVersion;
  if (version !== PLUGIN_MANIFEST_VERSION) {
    throw new Error(`plugin: unsupported manifestVersion "${String(version)}" (expected ${PLUGIN_MANIFEST_VERSION})`);
  }
  if (!str(m.name)) throw new Error("plugin: missing name");
  if (!str(m.version)) throw new Error("plugin: missing version");
  const dependsOn = m.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => !str(d))) {
    throw new Error("plugin: dependsOn must be a string array");
  }
  const provides = m.provides ?? [];
  if (!Array.isArray(provides)) throw new Error("plugin: provides must be an array");
  for (const p of provides) {
    if (typeof p !== "object" || p === null) throw new Error("plugin: each provides entry must be an object");
    const kind = (p as { kind?: unknown }).kind;
    const id = (p as { id?: unknown }).id;
    if (typeof kind !== "string" || !EXTENSION_KINDS.includes(kind as ExtensionKind)) {
      throw new Error(`plugin: unknown extension kind "${String(kind)}"`);
    }
    if (!str(id)) throw new Error("plugin: extension id must be a non-empty string");
  }
  if (m.entry !== undefined && !str(m.entry)) throw new Error("plugin: entry must be a string path");
  if (m.description !== undefined && typeof m.description !== "string") {
    throw new Error("plugin: description must be a string");
  }
  return {
    manifestVersion: PLUGIN_MANIFEST_VERSION,
    name: m.name as string,
    version: m.version as string,
    description: typeof m.description === "string" ? m.description : undefined,
    dependsOn: dependsOn as string[],
    provides: provides as { kind: ExtensionKind; id: string }[],
    entry: typeof m.entry === "string" ? m.entry : undefined,
  };
}

export function parseManifest(json: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`plugin: malformed manifest JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return validateManifest(raw);
}

/**
 * Topological order: dependencies first. Throws on a missing dependency or
 * a cycle (naming the participants), rather than loading half a graph.
 */
export function resolveLoadOrder(manifests: PluginManifest[]): PluginManifest[] {
  const byName = new Map<string, PluginManifest>();
  for (const m of manifests) {
    if (byName.has(m.name)) throw new Error(`plugin: duplicate plugin "${m.name}"`);
    byName.set(m.name, m);
  }
  for (const m of manifests) {
    for (const d of m.dependsOn) {
      if (!byName.has(d)) throw new Error(`plugin "${m.name}" depends on missing plugin "${d}"`);
      if (d === m.name) throw new Error(`plugin "${m.name}" depends on itself`);
    }
  }
  const out: PluginManifest[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (name: string, stack: string[]): void => {
    const s = state.get(name) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      throw new Error(`plugin: dependency cycle (${[...stack.slice(stack.indexOf(name)), name].join(" -> ")})`);
    }
    state.set(name, 1);
    for (const d of byName.get(name)!.dependsOn) visit(d, [...stack, name]);
    state.set(name, 2);
    out.push(byName.get(name)!);
  };
  for (const m of manifests) visit(m.name, []);
  return out;
}

// --- extension registries ---

export class ExtensionRegistry {
  private items = new Map<string, ExtensionRecord>();
  private duplicatePolicy: "reject" | "replace" = "reject";

  setPolicy(policy: "reject" | "replace"): void {
    this.duplicatePolicy = policy;
  }

  /** Registers an extension. Throws on a duplicate unless policy is replace. */
  add(kind: ExtensionKind, id: string, plugin: string, value: unknown): void {
    if (!EXTENSION_KINDS.includes(kind)) throw new Error(`plugin: unknown kind "${String(kind)}"`);
    if (!str(id)) throw new Error("plugin: extension id must be a non-empty string");
    const key = `${kind}:${id}`;
    if (this.items.has(key)) {
      if (this.duplicatePolicy === "reject") {
        throw new Error(`plugin: extension ${kind} "${id}" already provided by "${this.items.get(key)!.plugin}"`);
      }
      this.items.delete(key);
    }
    this.items.set(key, { kind, id, plugin, value });
  }

  removePlugin(plugin: string): number {
    let n = 0;
    for (const [key, rec] of [...this.items]) {
      if (rec.plugin === plugin) {
        this.items.delete(key);
        n++;
      }
    }
    return n;
  }

  get(kind: ExtensionKind, id: string): unknown {
    return this.items.get(`${kind}:${id}`)?.value;
  }

  has(kind: ExtensionKind, id: string): boolean {
    return this.items.has(`${kind}:${id}`);
  }

  list(kind?: ExtensionKind): ExtensionRecord[] {
    const all = [...this.items.values()];
    return kind ? all.filter((r) => r.kind === kind) : all;
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

// A registered game system. Kept structural so the host does not need to
// import Engine (which would pull in WebGL).
export interface PluginSystem {
  update?: (dt: number, world: World) => void;
  fixedUpdate?: (dt: number, world: World) => void;
  dispose?: (world: World) => void;
}

export interface PluginEditorPanel {
  title: string;
  mount: (parent: HTMLElement) => void | (() => void);
}

export interface PluginImporter {
  extensions: string[]; // e.g. [".gltf", ".glb"]
  label: string;
  /** Returns imported asset descriptors; throws on unsupported content. */
  import: (data: ArrayBuffer | string, id: string) => unknown;
}

export interface PluginTool {
  label: string;
  run: () => void;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  extensions: number;
  loadedAt: number;
}

export interface PluginHostOptions {
  now?: () => number;
  onError?: (plugin: string, error: unknown) => void;
}

/**
 * Holds manifests + extensions, resolves load order and keeps a record of
 * what is active. A plugin that throws while registering is rolled back
 * (its extensions are removed) and reported - it never half-loads.
 */
export class PluginHost {
  readonly registry = new ExtensionRegistry();
  private manifests: PluginManifest[] = [];
  private active = new Map<string, LoadedPlugin>();
  private systems: PluginSystem[] = [];
  private now: () => number;
  private onError: (plugin: string, error: unknown) => void;

  constructor(opts: PluginHostOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => undefined);
  }

  get loaded(): LoadedPlugin[] {
    return [...this.active.values()];
  }

  get systemCount(): number {
    return this.systems.length;
  }

  /** Validates + records a manifest without activating it. */
  register(manifest: PluginManifest): void {
    this.manifests.push(manifest);
  }

  /** Recorded manifests (dependency order is resolved at load time). */
  get manifestList(): PluginManifest[] {
    return [...this.manifests];
  }

  registerJSON(json: string): void {
    this.register(parseManifest(json));
  }

  /**
   * Activates everything in dependency order. `values` maps
   * "kind:id" to the actual implementation.
   */
  loadAll(values: Record<string, unknown> = {}): LoadedPlugin[] {
    const order = resolveLoadOrder(this.manifests);
    for (const manifest of order) {
      if (this.active.has(manifest.name)) continue;
      const before = this.registry.size;
      const systemsBefore = this.systems.length;
      try {
        for (const p of manifest.provides) {
          const value = values[`${p.kind}:${p.id}`];
          if (value === undefined) {
            throw new Error(`missing implementation for ${p.kind} "${p.id}"`);
          }
          this.registry.add(p.kind, p.id, manifest.name, value);
          if (p.kind === "system") this.systems.push(value as PluginSystem);
        }
        this.active.set(manifest.name, {
          manifest,
          extensions: this.registry.size - before,
          loadedAt: this.now(),
        });
      } catch (err) {
        // Roll back so a failed plugin leaves no half-registered extensions.
        this.registry.removePlugin(manifest.name);
        this.systems.length = systemsBefore;
        this.active.delete(manifest.name);
        this.onError(manifest.name, err);
      }
    }
    return this.loaded;
  }

  /** Unloads a plugin and everything that depends on it. */
  unload(name: string, world?: World): number {
    const dependents = this.manifests
      .filter((m) => m.dependsOn.includes(name) && this.active.has(m.name))
      .map((m) => m.name);
    for (const d of dependents) this.unload(d, world);
    if (!this.active.has(name)) return 0;
    const record = this.active.get(name)!;
    for (const p of record.manifest.provides) {
      if (p.kind === "system") {
        const sys = this.registry.get("system", p.id) as PluginSystem | undefined;
        if (sys?.dispose && world) {
          try {
            sys.dispose(world);
          } catch (err) {
            this.onError(name, err);
          }
        }
      }
    }
    this.systems = this.systems.filter((s) => !record.manifest.provides.some(
      (p) => p.kind === "system" && (this.registry.get("system", p.id) === s)
    ));
    const removed = this.registry.removePlugin(name);
    this.active.delete(name);
    this.manifests = this.manifests.filter((m) => m.name !== name);
    return removed;
  }

  update(dt: number, world: World): number {
    let n = 0;
    for (const s of this.systems) {
      if (!s.update) continue;
      try {
        s.update(dt, world);
        n++;
      } catch (err) {
        this.onError("system", err);
      }
    }
    return n;
  }

  allSystems(): PluginSystem[] {
    return [...this.systems];
  }

  panels(): PluginEditorPanel[] {
    return this.registry.list("editorPanel").map((r) => r.value as PluginEditorPanel);
  }

  importers(): PluginImporter[] {
    return this.registry.list("importer").map((r) => r.value as PluginImporter);
  }

  tools(): PluginTool[] {
    return this.registry.list("tool").map((r) => r.value as PluginTool);
  }

  /** Every registered importer that claims this file extension. */
  importerFor(filename: string): PluginImporter | null {
    const lower = filename.toLowerCase();
    for (const imp of this.importers()) {
      if (imp.extensions.some((e) => lower.endsWith(e.toLowerCase()))) return imp;
    }
    return null;
  }
}

/** Minimal example manifest used by the demo and the tests. */
export const SAMPLE_MANIFEST: PluginManifest = {
  manifestVersion: PLUGIN_MANIFEST_VERSION,
  name: "sample-weather",
  version: "1.0.0",
  description: "Adds a fog-of-war component, a system and a console tool.",
  dependsOn: [],
  provides: [
    { kind: "component", id: "weather" },
    { kind: "system", id: "weather-tick" },
    { kind: "tool", id: "weather-now" },
  ],
};
