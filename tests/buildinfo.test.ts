import { describe, expect, it } from "vitest";
import {
  BUILD_PLATFORMS, DEFAULT_BUILD_SETTINGS, TARGETS_BY_PLATFORM, buildableHere, describeBuild,
  isValidAppId, isValidVersion, resolveTargets, sanitizeBuildSettings, sanitizeHostInfo,
  sanitizePlatforms, sanitizeRelativePath, toElectronBuilderConfig, type BuildSettings,
} from "../src/core/buildinfo.js";

const base = (over: Partial<BuildSettings> = {}): BuildSettings => ({ ...DEFAULT_BUILD_SETTINGS, ...over });

describe("validation helpers", () => {
  it("accepts sensible app ids and rejects the rest", () => {
    expect(isValidAppId("com.glitch.game")).toBe(true);
    expect(isValidAppId("com.acme.night-shift")).toBe(true);
    expect(isValidAppId("nodots")).toBe(false);
    expect(isValidAppId("")).toBe(false);
    expect(isValidAppId("with space.id")).toBe(false);
    expect(isValidAppId("-leading.id")).toBe(false);
    expect(isValidAppId("x".repeat(200))).toBe(false);
  });

  it("accepts short and long version strings", () => {
    expect(isValidVersion("1")).toBe(true);
    expect(isValidVersion("1.2")).toBe(true);
    expect(isValidVersion("1.2.3")).toBe(true);
    expect(isValidVersion("1.2.3-beta.1")).toBe(true);
    expect(isValidVersion("v1.2.3")).toBe(false);
    expect(isValidVersion("1.2.3.4")).toBe(false);
    expect(isValidVersion("")).toBe(false);
  });

  it("keeps only known platforms, without duplicates", () => {
    expect(sanitizePlatforms(["win", "linux", "linux"])).toEqual(["win", "linux"]);
    expect(sanitizePlatforms(["WIN", "Mac"])).toEqual(["win", "mac"]);
    expect(sanitizePlatforms(["playstation"])).toEqual(["win"]);
    expect(sanitizePlatforms("win")).toEqual(["win"]);
    expect(BUILD_PLATFORMS).toHaveLength(3);
  });

  it("refuses absolute, traversing and reserved-character paths", () => {
    expect(sanitizeRelativePath("release")).toBe("release");
    expect(sanitizeRelativePath("out\\build")).toBe("out/build");
    expect(sanitizeRelativePath("/etc/passwd")).toBeNull();
    expect(sanitizeRelativePath("C:/Windows")).toBeNull();
    expect(sanitizeRelativePath("../../etc")).toBeNull();
    expect(sanitizeRelativePath("a/../b")).toBeNull();
    expect(sanitizeRelativePath('bad"name')).toBeNull();
    expect(sanitizeRelativePath(42)).toBeNull();
    expect(sanitizeRelativePath("")).toBeNull();
  });
});

describe("sanitizeBuildSettings", () => {
  it("returns the defaults for junk input", () => {
    expect(sanitizeBuildSettings(null)).toEqual(DEFAULT_BUILD_SETTINGS);
    expect(sanitizeBuildSettings("nope")).toEqual(DEFAULT_BUILD_SETTINGS);
    expect(sanitizeBuildSettings({})).toEqual(DEFAULT_BUILD_SETTINGS);
  });

  it("keeps valid values", () => {
    const s = sanitizeBuildSettings({
      productName: "Night Shift", appId: "com.h3llo.nightshift", version: "0.9.1",
      platforms: ["win", "linux"], icon: "assets/icon.png", outDir: "out", publish: true,
    });
    expect(s).toEqual({
      productName: "Night Shift", appId: "com.h3llo.nightshift", version: "0.9.1",
      platforms: ["win", "linux"], icon: "assets/icon.png", outDir: "out",
      publish: true, removeArtifacts: true,
    });
  });

  it("falls back per field instead of rejecting the whole file", () => {
    const s = sanitizeBuildSettings({ appId: "nope", version: "v9", productName: 42, icon: "/etc/passwd" });
    expect(s.appId).toBe(DEFAULT_BUILD_SETTINGS.appId);
    expect(s.version).toBe(DEFAULT_BUILD_SETTINGS.version);
    expect(s.productName).toBe(DEFAULT_BUILD_SETTINGS.productName);
    expect(s.icon).toBeNull();
  });

  it("accepts an explicit null icon", () => {
    expect(sanitizeBuildSettings({ icon: null }).icon).toBeNull();
  });

  it("drops unknown keys and control characters", () => {
    const s = sanitizeBuildSettings({ productName: "AB", scripts: { postinstall: "rm -rf /" } }) as
      unknown as Record<string, unknown>;
    expect(s.productName).toBe("AB");
    expect(s.scripts).toBeUndefined();
  });

  it("clamps a very long product name", () => {
    expect(sanitizeBuildSettings({ productName: "x".repeat(500) }).productName.length).toBe(64);
  });

  it("can inherit from a different base", () => {
    const mine = base({ productName: "Undercity", version: "0.8.0" });
    const s = sanitizeBuildSettings({ productName: "Override" }, mine);
    expect(s.productName).toBe("Override");
    expect(s.version).toBe("0.8.0");
  });
});

describe("targets", () => {
  it("resolves every format per platform", () => {
    const t = resolveTargets(base({ platforms: ["win", "linux"] }));
    expect(t).toHaveLength(TARGETS_BY_PLATFORM.win.length + TARGETS_BY_PLATFORM.linux.length);
    expect(t.some((x) => x.platform === "linux" && x.target === "AppImage")).toBe(true);
    expect(t.some((x) => x.platform === "win" && x.target === "portable")).toBe(true);
  });

  it("keeps only the host platform when cross-building is not allowed", () => {
    const s = base({ platforms: ["win", "linux", "mac"] });
    expect(buildableHere("win", s)).toEqual(["win"]);
    expect(buildableHere("linux", base({ platforms: ["linux"] }))).toEqual(["linux"]);
  });
});

describe("toElectronBuilderConfig", () => {
  it("emits one section per platform", () => {
    const cfg = toElectronBuilderConfig(base({ platforms: ["win", "linux", "mac"] })) as Record<string, Record<string, unknown>>;
    expect(Array.isArray(cfg.win.target)).toBe(true);
    expect(cfg.linux.target).toContain("AppImage");
    expect(cfg.mac.target).toContain("dmg");
    expect((cfg.mac as { category: string }).category).toContain("games");
  });

  it("omits sections for platforms that are not selected", () => {
    const cfg = toElectronBuilderConfig(base({ platforms: ["linux"] })) as Record<string, unknown>;
    expect(cfg.win).toBeUndefined();
    expect(cfg.mac).toBeUndefined();
    expect(cfg.linux).toBeDefined();
  });

  it("carries the id, name, output folder and icon", () => {
    const cfg = toElectronBuilderConfig(
      base({ productName: "Undercity", appId: "com.h3llo.undercity", outDir: "out", icon: "icon.png" })
    ) as Record<string, unknown>;
    expect(cfg.appId).toBe("com.h3llo.undercity");
    expect(cfg.productName).toBe("Undercity");
    expect(cfg.icon).toBe("icon.png");
    expect((cfg.directories as { output: string }).output).toBe("out");
  });

  it("omits the icon when there is none", () => {
    const cfg = toElectronBuilderConfig(base({ icon: null })) as Record<string, unknown>;
    expect(cfg.icon).toBeUndefined();
  });

  it("accepts custom file globs and a build host", () => {
    const cfg = toElectronBuilderConfig(base(), { files: ["game/**/*"], host: "linux" }) as Record<string, unknown>;
    expect(cfg.files).toEqual(["game/**/*"]);
    expect(cfg.buildHost).toEqual({ target: "linux" });
  });
});

describe("describeBuild", () => {
  it("summarizes name, version, host and targets", () => {
    const s = base({ productName: "Undercity", version: "0.8.0", platforms: ["win"] });
    const line = describeBuild(s, "win32");
    expect(line).toContain("Undercity 0.8.0");
    expect(line).toContain("win32");
    expect(line).toContain("win/portable");
    expect(describeBuild(s)).not.toContain("undefined");
  });
});

describe("sanitizeHostInfo", () => {
  it("keeps only known string fields", () => {
    const h = sanitizeHostInfo({ platform: "win32", arch: "x64", electron: "44.4.5", chrome: "140", node: "22", extra: 1 });
    expect(h).toEqual({ platform: "win32", arch: "x64", electron: "44.4.5", chrome: "140", node: "22" });
  });

  it("falls back for missing or oversized values", () => {
    expect(sanitizeHostInfo(undefined).platform).toBe("unknown");
    expect(sanitizeHostInfo({ platform: 5 }).platform).toBe("unknown");
    expect(sanitizeHostInfo({ platform: "p".repeat(200) }).platform.length).toBe(40);
  });
});
