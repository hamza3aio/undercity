// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuildSettingsService } from "../src/core/buildservice.js";
import { DEFAULT_BUILD_SETTINGS } from "../src/core/buildinfo.js";

interface BridgeStub {
  hostInfo: ReturnType<typeof vi.fn>;
  readBuildSettings: ReturnType<typeof vi.fn>;
  writeBuildSettings: ReturnType<typeof vi.fn>;
}

function stubBridge(over: Partial<BridgeStub> = {}): BridgeStub {
  const b: BridgeStub = {
    hostInfo: vi.fn(async () => ({
      platform: "win32", arch: "x64", electron: "44.4.5", chrome: "140", node: "22",
    })),
    readBuildSettings: vi.fn(async () => null),
    writeBuildSettings: vi.fn(async () => true),
    ...over,
  };
  (window as unknown as { glitch: unknown }).glitch = b;
  return b;
}

/** Minimal localStorage stand-in: jsdom's is unavailable on an opaque origin. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
  return store;
}

let store: Map<string, string>;

beforeEach(() => {
  store = installStorage();
  delete (window as unknown as { glitch?: unknown }).glitch;
});

afterEach(() => {
  delete (window as unknown as { glitch?: unknown }).glitch;
});

describe("build settings service without a host bridge (browser)", () => {
  it("starts from the defaults", () => {
    const s = createBuildSettingsService();
    expect(s.settings).toEqual(DEFAULT_BUILD_SETTINGS);
    expect(s.projectPath).toBeNull();
    expect(s.host.platform).toBe("unknown");
  });

  it("persists to localStorage when there is no project folder", () => {
    const s = createBuildSettingsService();
    s.save({ productName: "Browser Build" });
    expect(s.settings.productName).toBe("Browser Build");
    const stored = JSON.parse(window.localStorage.getItem("glitch.buildSettings")!);
    expect(stored.productName).toBe("Browser Build");
  });

  it("validates on save and falls back per field", () => {
    const s = createBuildSettingsService();
    const saved = s.save({ appId: "nope", platforms: ["linux", "atari"] } as never);
    expect(saved.appId).toBe(DEFAULT_BUILD_SETTINGS.appId);
    expect(saved.platforms).toEqual(["linux"]);
  });

  it("reports nothing buildable when the host is unknown", () => {
    const s = createBuildSettingsService();
    s.save({ platforms: ["win", "linux"] });
    expect(s.buildableTargets()).toEqual([]);
    expect(s.summary()).toContain("not buildable on this host");
  });

  it("survives corrupt local storage", () => {
    window.localStorage.setItem("glitch.buildSettings", "{not json");
    const s = createBuildSettingsService();
    expect(s.settings).toEqual(DEFAULT_BUILD_SETTINGS);
  });
});

describe("build settings service with the Electron bridge", () => {
  it("loads the project's build.json and the host facts", async () => {
    stubBridge({
      readBuildSettings: vi.fn(async () => ({ productName: "Night Shift", platforms: ["win", "linux"] })),
    });
    const s = createBuildSettingsService();
    await s.load("C:/projects/nightshift");
    expect(s.projectPath).toBe("C:/projects/nightshift");
    expect(s.settings.productName).toBe("Night Shift");
    expect(s.settings.platforms).toEqual(["win", "linux"]);
    expect(s.host.electron).toBe("44.4.5");
  });

  it("keeps the current settings when build.json is unreadable", async () => {
    const b = stubBridge();
    b.readBuildSettings = vi.fn(async () => {
      throw new Error("EACCES");
    });
    const s = createBuildSettingsService();
    s.save({ productName: "Keep Me" });
    await s.load("C:/projects/x");
    expect(s.settings.productName).toBe("Keep Me");
  });

  it("writes sanitized settings to the project", async () => {
    const b = stubBridge();
    const s = createBuildSettingsService();
    await s.load("C:/projects/x");
    s.save({ productName: "Undercity", version: "0.9.0", version2: undefined } as never);
    expect(b.writeBuildSettings).toHaveBeenCalledTimes(1);
    const [path, written] = b.writeBuildSettings.mock.calls[0];
    expect(path).toBe("C:/projects/x");
    expect((written as { productName: string }).productName).toBe("Undercity");
    expect((written as { version: string }).version).toBe("0.9.0");
    // localStorage is not used when a project folder is set.
    expect(window.localStorage.getItem("glitch.buildSettings")).toBeNull();
  });

  it("reset restores the defaults and writes them", async () => {
    const b = stubBridge();
    const s = createBuildSettingsService();
    await s.load("C:/projects/x");
    s.save({ productName: "Temp" });
    s.reset();
    expect(s.settings).toEqual(DEFAULT_BUILD_SETTINGS);
    expect(b.writeBuildSettings).toHaveBeenCalledTimes(2);
  });

  it("only claims targets the host can build", async () => {
    stubBridge();
    const s = createBuildSettingsService();
    await s.load("C:/projects/x");
    s.save({ platforms: ["win", "linux", "mac"] });
    expect(s.buildableTargets()).toEqual(["portable", "nsis", "zip"]);
    expect(s.summary()).toContain("buildable here");
  });

  it("emits an electron-builder config for the current settings", async () => {
    stubBridge();
    const s = createBuildSettingsService();
    await s.load("C:/projects/x");
    s.save({ productName: "Undercity", appId: "com.h3llo.undercity", platforms: ["win"] });
    const cfg = s.builderConfig() as Record<string, unknown>;
    expect(cfg.productName).toBe("Undercity");
    expect(cfg.appId).toBe("com.h3llo.undercity");
    expect(cfg.buildHost).toEqual({ target: "win" });
    expect(cfg.linux).toBeUndefined();
  });

  it("treats a darwin host as mac", async () => {
    stubBridge({ hostInfo: vi.fn(async () => ({ platform: "darwin", arch: "arm64", electron: "44", chrome: "140", node: "22" })) });
    const s = createBuildSettingsService();
    await s.load("C:/projects/x");
    s.save({ platforms: ["win", "mac"] });
    expect(s.buildableTargets()).toEqual(["dmg", "zip"]);
    expect((s.builderConfig() as Record<string, unknown>).buildHost).toEqual({ target: "mac" });
  });
});
