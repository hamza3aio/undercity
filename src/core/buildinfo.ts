// Glitch build settings (Phase 20) — what to package, and on which hosts.
//
// Pure module: no Electron, no fs. The main process reads/writes the JSON,
// the engine validates it, and `electron-builder` consumes the same shape.
// Keeping the rules here means a project file can be checked (and tested)
// without launching a packaged build.

/** Platforms the engine can package for. */
export type BuildPlatform = "win" | "linux" | "mac";

/** Packaged formats per platform, mapped to electron-builder target ids. */
export const TARGETS_BY_PLATFORM: Record<BuildPlatform, string[]> = {
  win: ["portable", "nsis", "zip"],
  linux: ["AppImage", "tar.gz", "deb"],
  mac: ["dmg", "zip"],
};

export const BUILD_PLATFORMS: BuildPlatform[] = ["win", "linux", "mac"];

export interface BuildSettings {
  /** Executable / app-bundle name shown to users. */
  productName: string;
  /** Reverse-DNS identifier (Linux desktop entry, macOS bundle id). */
  appId: string;
  /** Project version; separate from the engine version. */
  version: string;
  /** Platforms to build. */
  platforms: BuildPlatform[];
  /** Icon file path, relative to the project, or null for the default. */
  icon: string | null;
  /** Output folder, relative to the project. */
  outDir: string;
  /** Publish (upload) artifacts on CI. Off by default. */
  publish: boolean;
  /** Strip debug symbols from packaged output where supported. */
  removeArtifacts: boolean;
}

export const DEFAULT_BUILD_SETTINGS: BuildSettings = {
  productName: "Glitch Game",
  appId: "com.glitch.game",
  version: "1.0.0",
  platforms: ["win"],
  icon: null,
  outDir: "release",
  publish: false,
  removeArtifacts: true,
};

// --- validation helpers ---

const NAME_MAX = 64;
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
// Control characters are never valid in a name, id, version or path.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const SEMVER_RE = /^\d+(\.\d+){0,2}(-[0-9a-z.-]+)?$/i;

function str(v: unknown, fallback: string, max = NAME_MAX): string {
  if (typeof v !== "string") return fallback;
  const clean = v.replace(CONTROL_CHARS, "").trim().slice(0, max);
  return clean.length > 0 ? clean : fallback;
}

/** Rejects anything that is not a usable reverse-DNS-ish id. */
export function isValidAppId(v: string): boolean {
  return v.length > 0 && v.length <= 155 && ID_RE.test(v) && v.includes(".");
}

/** Accepts "1", "1.2", "1.2.3" and a prerelease suffix. */
export function isValidVersion(v: string): boolean {
  return SEMVER_RE.test(v);
}

/** Drops unknown platforms, keeps order, never empty. */
export function sanitizePlatforms(v: unknown): BuildPlatform[] {
  const list = Array.isArray(v) ? v : [];
  const out: BuildPlatform[] = [];
  for (const p of list) {
    if (typeof p !== "string") continue;
    const lower = p.toLowerCase();
    if (!BUILD_PLATFORMS.includes(lower as BuildPlatform)) continue;
    if (!out.includes(lower as BuildPlatform)) out.push(lower as BuildPlatform);
  }
  return out.length > 0 ? out : [...DEFAULT_BUILD_SETTINGS.platforms];
}

/**
 * Rejects paths that escape the project or hit reserved Windows characters.
 * Returns the cleaned relative path, or null when unusable.
 */
export function sanitizeRelativePath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const clean = v.replace(CONTROL_CHARS, "").trim().replace(/\\/g, "/");
  if (clean.length === 0) return null;
  if (/^([a-z]:)?\//i.test(clean)) return null; // absolute
  if (clean.split("/").some((seg) => seg === "..")) return null; // traversal
  if (/[<>:"|?*]/.test(clean)) return null;
  return clean.slice(0, 200);
}

/** Fills in defaults and clamps every field. Unknown keys are dropped. */
export function sanitizeBuildSettings(raw: unknown, base: BuildSettings = DEFAULT_BUILD_SETTINGS): BuildSettings {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const productName = str(s.productName, base.productName);
  const appId = str(s.appId, base.appId, 155);
  const version = str(s.version, base.version, 32);
  const icon = s.icon === null ? null : sanitizeRelativePath(s.icon);
  const outDir = sanitizeRelativePath(s.outDir) ?? base.outDir;
  return {
    productName,
    appId: isValidAppId(appId) ? appId : base.appId,
    version: isValidVersion(version) ? version : base.version,
    platforms: sanitizePlatforms(s.platforms ?? base.platforms),
    icon,
    outDir,
    publish: typeof s.publish === "boolean" ? s.publish : base.publish,
    removeArtifacts: typeof s.removeArtifacts === "boolean" ? s.removeArtifacts : base.removeArtifacts,
  };
}

/** Every format that the selected platforms will produce. */
export function resolveTargets(settings: BuildSettings): { platform: BuildPlatform; target: string }[] {
  const out: { platform: BuildPlatform; target: string }[] = [];
  for (const platform of settings.platforms) {
    for (const target of TARGETS_BY_PLATFORM[platform]) out.push({ platform, target });
  }
  return out;
}

/** Platforms the current host can build for (cross-building is limited). */
export function buildableHere(host: BuildPlatform, settings: BuildSettings): BuildPlatform[] {
  return settings.platforms.filter((p) => p === host);
}

/**
 * The electron-builder config fragment a project needs. Kept here (not in the
 * main process) so it is covered by tests: a typo in a target id otherwise
 * only shows up as a failed CI build.
 */
export function toElectronBuilderConfig(
  settings: BuildSettings,
  opts: { files?: string[]; host?: BuildPlatform } = {}
): Record<string, unknown> {
  const files = opts.files && opts.files.length > 0
    ? opts.files
    : ["dist/**/*", "electron/**/*", "project-template/**/*", "package.json"];
  const config: Record<string, unknown> = {
    appId: settings.appId,
    productName: settings.productName,
    directories: { output: settings.outDir },
    files,
  };
  if (settings.icon) config.icon = settings.icon;
  if (settings.removeArtifacts) config.npmRebuild = false;
  for (const platform of settings.platforms) {
    const targets = TARGETS_BY_PLATFORM[platform];
    if (platform === "mac") {
      config.mac = { target: targets, category: "public.app-category.games" };
    } else if (platform === "linux") {
      config.linux = {
        target: targets,
        category: "Game",
        synopsis: settings.productName,
        maintainer: settings.appId,
      };
    } else {
      config.win = { target: targets };
    }
  }
  if (opts.host) config.buildHost = { target: opts.host };
  return config;
}

/** A short one-line summary for the launcher status line. */
export function describeBuild(settings: BuildSettings, host?: string): string {
  const targets = resolveTargets(settings).map((t) => `${t.platform}/${t.target}`);
  const where = host ? ` on ${host}` : "";
  return `${settings.productName} ${settings.version}${where} · ${targets.join(", ")}`;
}

/** Host facts the main process reports (versions, arch). */
export interface HostInfo {
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
}

/** Narrows an arbitrary object to HostInfo, dropping unknown fields. */
export function sanitizeHostInfo(raw: unknown): HostInfo {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const v = (x: unknown): string => (typeof x === "string" ? x.slice(0, 40) : "");
  return {
    platform: v(s.platform) || "unknown",
    arch: v(s.arch) || "unknown",
    electron: v(s.electron) || "unknown",
    chrome: v(s.chrome) || "unknown",
    node: v(s.node) || "unknown",
  };
}
