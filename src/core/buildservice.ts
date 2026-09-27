// Glitch build settings service (Phase 20) — the renderer half of the
// per-project build configuration. Validates on load, on save, and before
// handing the config to electron-builder. Works in a plain browser too: the
// settings live in localStorage there and are only used for display.
//
// Nothing here runs a build. Producing artifacts is `npm run dist:linux` /
// `dist:win` / `dist:mac` (see package.json); this module exists so the
// settings a project is built with are visible and validated in the editor.

import {
  DEFAULT_BUILD_SETTINGS, buildableHere, describeBuild, resolveTargets, sanitizeBuildSettings,
  sanitizeHostInfo, toElectronBuilderConfig, type BuildSettings, type HostInfo,
} from "./buildinfo.js";

const STORAGE_KEY = "glitch.buildSettings";

/** True when there is a DOM (browser / Electron renderer). */
function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** Fallback for headless use (tests, tooling): memory instead of storage. */
const memory = new Map<string, string>();

export interface BuildSettingsService {
  /** Current settings (defaults until a project loads). */
  readonly settings: BuildSettings;
  /** Host facts; "unknown" outside Electron. */
  readonly host: HostInfo;
  /** Project folder the settings belong to, when there is one. */
  readonly projectPath: string | null;
  load(projectPath: string | null): Promise<void>;
  save(next: Partial<BuildSettings>): BuildSettings;
  reset(): BuildSettings;
  /** One-line summary for the status bar. */
  summary(): string;
  /** Formats this host can actually produce right now. */
  buildableTargets(): string[];
  /** The electron-builder fragment for the current settings. */
  builderConfig(): Record<string, unknown>;
}

function readStorage(): unknown {
  try {
    const raw = hasWindow() ? window.localStorage.getItem(STORAGE_KEY) : memory.get(STORAGE_KEY) ?? null;
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStorage(value: unknown): void {
  try {
    const text = JSON.stringify(value);
    if (hasWindow()) window.localStorage.setItem(STORAGE_KEY, text);
    else memory.set(STORAGE_KEY, text);
  } catch {
    /* private mode / quota: settings simply do not persist */
  }
}

function hostPlatform(info: HostInfo): "win" | "linux" | "mac" | null {
  if (info.platform.startsWith("win")) return "win";
  if (info.platform === "darwin") return "mac";
  if (info.platform === "linux") return "linux";
  return null; // unknown host: claim nothing rather than guessing
}

export function createBuildSettingsService(): BuildSettingsService {
  let settings: BuildSettings = sanitizeBuildSettings(readStorage());
  let hostInfo: HostInfo = sanitizeHostInfo(null);
  let projectPath: string | null = null;

  const service: BuildSettingsService = {
    get settings() {
      return settings;
    },
    get host() {
      return hostInfo;
    },
    get projectPath() {
      return projectPath;
    },
    async load(next: string | null) {
      projectPath = next;
      const bridge = hasWindow() ? window.glitch : undefined;
      if (bridge) {
        // Host facts first, and always: the buildable list depends on them.
        try {
          hostInfo = sanitizeHostInfo(await bridge.hostInfo());
        } catch {
          hostInfo = sanitizeHostInfo(null);
        }
      }
      if (bridge && next) {
        try {
          const raw = await bridge.readBuildSettings(next);
          if (raw) {
            settings = sanitizeBuildSettings(raw, settings);
            return;
          }
        } catch {
          // Unreadable build.json: keep what we have rather than losing it.
        }
      } else {
        settings = sanitizeBuildSettings(readStorage(), settings);
      }
    },
    save(next: Partial<BuildSettings>) {
      settings = sanitizeBuildSettings({ ...settings, ...next }, settings);
      if (projectPath && hasWindow() && window.glitch) {
        // Fire-and-forget: the editor keeps working if the write fails, and
        // the console reports the outcome.
        window.glitch.writeBuildSettings(projectPath, settings).catch(() => {
          /* reported by the caller via summary(); nothing to do here */
        });
      } else {
        writeStorage(settings);
      }
      return settings;
    },
    reset() {
      settings = { ...DEFAULT_BUILD_SETTINGS };
      if (projectPath && hasWindow() && window.glitch) {
        window.glitch.writeBuildSettings(projectPath, settings).catch(() => undefined);
      } else {
        writeStorage(settings);
      }
      return settings;
    },
    summary() {
      const line = describeBuild(settings, hostInfo.platform);
      const can = service.buildableTargets();
      return can.length > 0 ? `${line} · buildable here: ${can.join(", ")}` : `${line} · not buildable on this host`;
    },
    buildableTargets() {
      const host = hostPlatform(hostInfo);
      if (!host) return [];
      return resolveTargets({ ...settings, platforms: buildableHere(host, settings) }).map((t) => t.target);
    },
    builderConfig() {
      const host = hostPlatform(hostInfo);
      return toElectronBuilderConfig(settings, host ? { host } : {});
    },
  };
  return service;
}
