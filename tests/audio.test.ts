import { describe, expect, it } from "vitest";
import { clampGain, dbToGain, gainToDb, inverseAttenuation } from "../src/audio/volume.js";
import { renderArp, renderNoise, renderSweep, renderThump } from "../src/audio/sfx.js";

// Deterministic rand for tests.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function peak(s: Float32Array): number {
  let p = 0;
  for (let i = 0; i < s.length; i++) p = Math.max(p, Math.abs(s[i]));
  return p;
}

function energy(s: Float32Array): number {
  let e = 0;
  for (let i = 0; i < s.length; i++) e += s[i] * s[i];
  return e / Math.max(1, s.length);
}

describe("volume math", () => {
  it("converts dB/gain with known anchors", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(-100)).toBe(0);
    expect(dbToGain(-1000)).toBe(0);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 9);
  });

  it("inverse attenuation is 1 at ref and halves per doubling", () => {
    expect(inverseAttenuation(0.5, 1)).toBe(1);
    expect(inverseAttenuation(1, 1)).toBe(1);
    expect(inverseAttenuation(2, 1)).toBeCloseTo(0.5);
    expect(inverseAttenuation(4, 1)).toBeCloseTo(0.25);
    expect(inverseAttenuation(100, 1)).toBeGreaterThan(0);
  });

  it("clamps gains", () => {
    expect(clampGain(-1)).toBe(0);
    expect(clampGain(0.5)).toBe(0.5);
    expect(clampGain(5)).toBe(2);
  });
});

describe("synth SFX", () => {
  it("renders correct lengths and bounded peaks", () => {
    const sr = 22050;
    for (const fn of [renderThump, renderNoise, renderSweep, renderArp]) {
      const s = fn({ sampleRate: sr, duration: 0.2, rand: seeded(42) });
      expect(s.length).toBe(Math.floor(sr * 0.2));
      expect(peak(s)).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic for a fixed rand", () => {
    const a = renderNoise({ rand: seeded(7) });
    const b = renderNoise({ rand: seeded(7) });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("thump is lowpassed noise with decay envelope", () => {
    const s = renderThump({ duration: 0.3, gain: 1, rand: seeded(3) });
    expect(energy(s)).toBeGreaterThan(0);
    // envelope: first quarter carries more energy than the last quarter
    const q = Math.floor(s.length / 4);
    let first = 0, last = 0;
    for (let i = 0; i < q; i++) first += s[i] * s[i];
    for (let i = s.length - q; i < s.length; i++) last += s[i] * s[i];
    expect(first).toBeGreaterThan(last);
  });

  it("sweep starts and ends near silence", () => {
    const s = renderSweep({ duration: 0.2, from: 200, to: 800 });
    expect(Math.abs(s[0])).toBeLessThan(0.05);
    expect(Math.abs(s[s.length - 1])).toBeLessThan(0.05);
    expect(peak(s)).toBeGreaterThan(0.2);
  });

  it("arpeggio plays distinct segments", () => {
    const s = renderArp({ duration: 0.3, notes: [440, 880], gain: 0.9 });
    const half = Math.floor(s.length / 2);
    let first = 0, second = 0;
    for (let i = 0; i < half; i++) first += Math.abs(s[i]);
    for (let i = half; i < s.length; i++) second += Math.abs(s[i]);
    // second segment (880Hz) oscillates faster: more zero crossings
    const crossings = (a: number, b: number) => {
      let c = 0;
      for (let i = a + 1; i < b; i++) if (Math.sign(s[i]) !== Math.sign(s[i - 1])) c++;
      return c;
    };
    expect(crossings(half, s.length)).toBeGreaterThan(crossings(0, half));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  });
});
