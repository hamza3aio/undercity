// Glitch plugin loader (renderer side) — turns manifests + entry module
// text into live extensions. The window has no fs access, so a disk plugin's
// entry file is imported through a blob URL; bundled plugins are handed in
// as already-evaluated modules. Every failure is reported to the host logger
// and the plugin is skipped, never half-loaded.

import { PluginHost, validateManifest, type PluginManifest } from "./host.js";

export interface DiskPlugin {
  dir: string;
  manifest?: unknown;
  entry?: string | null;
  error?: string;
}

/** What a plugin entry module must export. */
export interface PluginModule {
  /** "kind:id" -> implementation. */
  provide?: Record<string, unknown>;
  setup?: (host: PluginHost) => void | Promise<void>;
  teardown?: (host: PluginHost) => void;
}

export interface LoadReport {
  loaded: string[];
  skipped: { name: string; reason: string }[];
}

/** Imports ESM source text via a blob URL and returns its namespace. */
async function importSource(src: string): Promise<Record<string, unknown>> {
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Loads disk plugins (Electron) into the host. Bundled plugins can be
 * supplied through `bundled` and are registered first.
 */
export async function loadPlugins(
  host: PluginHost,
  opts: {
    bundled?: { manifest: PluginManifest; module: PluginModule }[];
    disk?: DiskPlugin[];
    onError?: (name: string, reason: string) => void;
  } = {}
): Promise<LoadReport> {
  const report: LoadReport = { loaded: [], skipped: [] };
  const onError = opts.onError ?? (() => undefined);
  const modules = new Map<string, PluginModule>();

  for (const b of opts.bundled ?? []) {
    try {
      host.register(b.manifest);
      modules.set(b.manifest.name, b.module);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.skipped.push({ name: b.manifest.name, reason });
      onError(b.manifest.name, reason);
    }
  }

  for (const d of opts.disk ?? []) {
    let name = d.dir;
    if (d.error) {
      report.skipped.push({ name, reason: d.error });
      onError(name, d.error);
      continue;
    }
    try {
      const manifest = validateManifest(d.manifest);
      name = manifest.name;
      host.register(manifest);
      if (d.entry) {
        const ns = await importSource(d.entry);
        modules.set(manifest.name, ns as PluginModule);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.skipped.push({ name, reason });
      onError(name, reason);
    }
  }

  // Build the "kind:id" -> value map the host expects, from each module.
  const values: Record<string, unknown> = {};
  for (const [pluginName, mod] of modules) {
    const manifest = host.manifestList.find((m) => m.name === pluginName);
    if (!manifest) continue;
    for (const p of manifest.provides) {
      const key = `${p.kind}:${p.id}`;
      const v = mod.provide?.[key];
      if (v === undefined) continue; // host reports the gap
      values[key] = v;
    }
  }

  for (const [pluginName, mod] of modules) {
    if (!mod.setup) continue;
    try {
      await mod.setup(host);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.skipped.push({ name: pluginName, reason });
      onError(pluginName, `setup: ${reason}`);
    }
  }

  for (const p of host.loadAll(values)) report.loaded.push(p.manifest.name);
  return report;
}
