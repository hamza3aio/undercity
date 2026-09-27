// Glitch quality settings — the player-facing graphics configuration.
// Pure data + sanitisation + versioned persistence (localStorage when
// present, silently in-memory when not, e.g. headless tests). The renderer
// reads `pixelScale`, the loop reads `fpsLimit`, and the shadow settings
// mirror `shadow*` fields. Presets are the "Low/Medium/High/Ultra" ladder
// the demo and games expose to players.

export type QualityLevel = "low" | "medium" | "high" | "ultra";
export const QUALITY_LEVELS: QualityLevel[] = ["low", "medium", "high", "ultra"];

export interface QualityConfig {
  level: QualityLevel;
  pixelScale: number; // 0.5..1 render-resolution multiplier
  fpsLimit: number; // 0 = uncapped, else target frames per second
  shadowSize: number; // 0 = shadows off, else requested map size (POT-snapped)
  shadowDistance: number; // world radius of the shadow cascade
  shadowSoftness: number; // 0..2 PCF taps exponent (informational)
  viewDistance: number; // far plane / fog far (world units)
  fogEnabled: boolean;
  postEnabled: boolean;
  pointLights: number; // max 1..4 active point lights
  textureMaxSize: number; // 256..4096, informational for importers
  particles: number; // particle pool budget
  gamma: number; // output encoding (1 = off, 2.2 = sRGB)
  tonemap: "none" | "reinhard" | "aces";
  exposure: number;
}

const LEVELS: Record<QualityLevel, Omit<QualityConfig, "level">> = {
  low: {
    pixelScale: 0.6, fpsLimit: 60, shadowSize: 0, shadowDistance: 25, shadowSoftness: 1,
    viewDistance: 120, fogEnabled: true, postEnabled: false, pointLights: 1,
    textureMaxSize: 512, particles: 64, gamma: 1, tonemap: "none", exposure: 1,
  },
  medium: {
    pixelScale: 0.8, fpsLimit: 60, shadowSize: 1024, shadowDistance: 32, shadowSoftness: 1,
    viewDistance: 180, fogEnabled: true, postEnabled: true, pointLights: 2,
    textureMaxSize: 1024, particles: 128, gamma: 1, tonemap: "none", exposure: 1,
  },
  high: {
    pixelScale: 1, fpsLimit: 60, shadowSize: 2048, shadowDistance: 42, shadowSoftness: 1,
    viewDistance: 240, fogEnabled: true, postEnabled: true, pointLights: 4,
    textureMaxSize: 2048, particles: 256, gamma: 1, tonemap: "none", exposure: 1,
  },
  ultra: {
    pixelScale: 1, fpsLimit: 0, shadowSize: 4096, shadowDistance: 60, shadowSoftness: 2,
    viewDistance: 320, fogEnabled: true, postEnabled: true, pointLights: 4,
    textureMaxSize: 4096, particles: 512, gamma: 1, tonemap: "reinhard", exposure: 1,
  },
};

export function qualityPreset(level: QualityLevel): QualityConfig {
  return { level, ...LEVELS[level] };
}

export const QUALITY_VERSION = 1;
const STORAGE_KEY = "glitch-quality-v1";

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Fills in anything missing/invalid from the closest preset, so a partially
// corrupt or older save still yields a usable config.
export function sanitizeQuality(raw: unknown, fallbackLevel: QualityLevel = "high"): QualityConfig {
  const base = qualityPreset(fallbackLevel);
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const level = (QUALITY_LEVELS.includes(r.level as QualityLevel) ? r.level : base.level) as QualityLevel;
  const p = LEVELS[level];
  const tone = r.tonemap;
  return {
    level,
    pixelScale: clamp(num(r.pixelScale, p.pixelScale), 0.5, 1),
    fpsLimit: clamp(Math.round(num(r.fpsLimit, p.fpsLimit)), 0, 240),
    shadowSize: clamp(Math.round(num(r.shadowSize, p.shadowSize)), 0, 8192),
    shadowDistance: clamp(num(r.shadowDistance, p.shadowDistance), 5, 200),
    shadowSoftness: clamp(num(r.shadowSoftness, p.shadowSoftness), 0, 2),
    viewDistance: clamp(num(r.viewDistance, p.viewDistance), 20, 2000),
    fogEnabled: typeof r.fogEnabled === "boolean" ? r.fogEnabled : p.fogEnabled,
    postEnabled: typeof r.postEnabled === "boolean" ? r.postEnabled : p.postEnabled,
    pointLights: clamp(Math.round(num(r.pointLights, p.pointLights)), 0, 4),
    textureMaxSize: clamp(Math.round(num(r.textureMaxSize, p.textureMaxSize)), 256, 4096),
    particles: clamp(Math.round(num(r.particles, p.particles)), 0, 4096),
    gamma: clamp(num(r.gamma, p.gamma), 1, 3),
    tonemap: tone === "reinhard" || tone === "aces" || tone === "none" ? tone : p.tonemap,
    exposure: clamp(num(r.exposure, p.exposure), 0.1, 8),
  };
}

export class QualitySettings {
  config: QualityConfig;

  constructor(level: QualityLevel = "high") {
    this.config = qualityPreset(level);
  }

  get level(): QualityLevel {
    return this.config.level;
  }

  /** Applies a preset wholesale, keeping the level in sync. */
  applyPreset(level: QualityLevel): void {
    this.config = qualityPreset(level);
  }

  /** Partial override; level is left alone unless explicitly given. */
  patch(p: Partial<QualityConfig>): void {
    this.config = sanitizeQuality({ ...this.config, ...p }, this.config.level);
  }

  get fpsLimitMs(): number {
    return this.config.fpsLimit > 0 ? 1000 / this.config.fpsLimit : 0;
  }

  toJSON(): { version: number; config: QualityConfig } {
    return { version: QUALITY_VERSION, config: { ...this.config } };
  }

  static fromJSON(data: unknown): QualitySettings {
    const q = new QualitySettings();
    if (typeof data !== "object" || data === null) return q;
    const d = data as { version?: unknown; config?: unknown };
    if (d.version !== undefined && d.version !== QUALITY_VERSION) {
      // Unknown future/older version: keep the preset rather than guessing.
      return q;
    }
    q.config = sanitizeQuality(d.config, q.config.level);
    return q;
  }

  save(): boolean {
    try {
      const ls = typeof localStorage !== "undefined" ? localStorage : null;
      if (!ls) return false;
      ls.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch {
      return false;
    }
  }

  static load(): QualitySettings {
    try {
      const ls = typeof localStorage !== "undefined" ? localStorage : null;
      if (!ls) return new QualitySettings();
      const raw = ls.getItem(STORAGE_KEY);
      if (!raw) return new QualitySettings();
      return QualitySettings.fromJSON(JSON.parse(raw));
    } catch {
      return new QualitySettings();
    }
  }
}

// --- frame pacing (pure decision, used by GameLoop) ---

// True when a frame should actually be presented. `minFrameMs` of 0 means
// uncapped. Browser vsync still applies on top: this only *caps* the rate.
export function shouldRenderFrame(elapsedSinceLastRenderMs: number, minFrameMs: number): boolean {
  if (!(minFrameMs > 0)) return true;
  return elapsedSinceLastRenderMs >= minFrameMs - 0.5; // 0.5ms tolerance for jitter
}
