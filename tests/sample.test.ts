import { describe, expect, it } from "vitest";
import { clipDuration, decodeWav, encodeWav, mixdown, type SampleClip } from "../src/audio/sample.js";
import { clipLengthSeconds, peak, rms, sequenceEvents, synthNote } from "../src/audio/synth.js";

function makeWav(opts: {
  format: number; channels: number; rate: number; bits: number; data: number[];
}): ArrayBuffer {
  const bytesPerSample = opts.bits / 8;
  const dataLen = opts.data.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.format, true);
  v.setUint16(22, opts.channels, true);
  v.setUint32(24, opts.rate, true);
  v.setUint32(28, opts.rate * opts.channels * bytesPerSample, true);
  v.setUint16(32, opts.channels * bytesPerSample, true);
  v.setUint16(34, opts.bits, true);
  ascii(36, "data");
  v.setUint32(40, dataLen, true);
  let p = 44;
  for (const s of opts.data) {
    if (opts.bits === 8) v.setUint8(p, s);
    else if (opts.bits === 16) v.setInt16(p, s, true);
    else v.setInt32(p, s, true);
    p += bytesPerSample;
  }
  return buf;
}

describe("WAV codec", () => {
  it("decodes 16-bit PCM values", () => {
    const clip = decodeWav(makeWav({
      format: 1, channels: 1, rate: 8000, bits: 16, data: [0, 16384, -16384, 32767],
    }));
    expect(clip.sampleRate).toBe(8000);
    expect(clip.channels).toHaveLength(1);
    expect(clip.channels[0][0]).toBe(0);
    expect(clip.channels[0][1]).toBeCloseTo(0.5, 4);
    expect(clip.channels[0][2]).toBeCloseTo(-0.5, 4);
    expect(clip.channels[0][3]).toBeCloseTo(1, 3);
    expect(clipDuration(clip)).toBeCloseTo(4 / 8000);
  });

  it("decodes unsigned 8-bit PCM", () => {
    const clip = decodeWav(makeWav({
      format: 1, channels: 1, rate: 8000, bits: 8, data: [0, 128, 255],
    }));
    expect(clip.channels[0][0]).toBe(-1);
    expect(clip.channels[0][1]).toBe(0);
    expect(clip.channels[0][2]).toBeCloseTo(127 / 128, 4);
  });

  it("round-trips stereo through the 16-bit writer", () => {
    const clip: SampleClip = {
      sampleRate: 22050,
      channels: [new Float32Array([0.25, -0.5, 0.9]), new Float32Array([-0.25, 0.5, -0.9])],
    };
    const back = decodeWav(encodeWav(clip));
    expect(back.sampleRate).toBe(22050);
    expect(back.channels).toHaveLength(2);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 3; i++) expect(back.channels[c][i]).toBeCloseTo(clip.channels[c][i], 3);
    }
  });

  it("rejects malformed and unsupported files", () => {
    expect(() => decodeWav(new ArrayBuffer(10))).toThrow(/too small/);
    const bad = new ArrayBuffer(44);
    expect(() => decodeWav(bad)).toThrow(/RIFF/);
    expect(() => decodeWav(makeWav({ format: 6, channels: 1, rate: 8000, bits: 8, data: [1] }))).toThrow(/unsupported format/);
    // fmt only, no data chunk
    const nodata = new ArrayBuffer(44);
    const v = new DataView(nodata);
    const ascii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF"); ascii(8, "WAVE"); ascii(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint16(34, 16, true);
    expect(() => decodeWav(nodata)).toThrow(/data chunk/);
    expect(() => encodeWav({ sampleRate: 8000, channels: [] })).toThrow(/no channels/);
  });
});

describe("mixdown", () => {
  it("layers at offsets, clamps, and validates rates", () => {
    const a: SampleClip = { sampleRate: 1000, channels: [new Float32Array([0.5, 0.5])] };
    const b: SampleClip = { sampleRate: 1000, channels: [new Float32Array([0.5])] };
    const out = mixdown([{ clip: a, atSeconds: 0 }, { clip: b, atSeconds: 0.001 }], 1000);
    expect(out.channels[0].length).toBe(2);
    expect(out.channels[0][0]).toBeCloseTo(0.5);
    expect(out.channels[0][1]).toBeCloseTo(1.0); // 0.5+0.5, clamped
    const hot: SampleClip = { sampleRate: 1000, channels: [new Float32Array([1, 1])] };
    expect(mixdown([{ clip: hot, atSeconds: 0 }, { clip: hot, atSeconds: 0 }], 1000).channels[0][0]).toBe(1);
    const other: SampleClip = { sampleRate: 2000, channels: [new Float32Array([1])] };
    expect(() => mixdown([{ clip: a, atSeconds: 0 }, { clip: other, atSeconds: 0 }], 1000)).toThrow(/mismatch/);
    expect(mixdown([], 1000).channels[0].length).toBe(0);
  });
});

describe("synthNote", () => {
  it("renders the right length with attack ramp and bounded peak", () => {
    const s = synthNote(440, 0.1, { sampleRate: 8000 });
    expect(s.sampleRate).toBe(8000);
    expect(s.channels[0].length).toBe(800);
    expect(s.channels[0][0]).toBe(0);
    expect(peak(s)).toBeLessThanOrEqual(0.9);
    expect(peak(s)).toBeGreaterThan(0.5);
    expect(rms(s)).toBeGreaterThan(0.1);
    expect(clipLengthSeconds(s)).toBeCloseTo(0.1);
  });

  it("supports wave types and rejects bad input", () => {
    for (const type of ["sine", "square", "saw", "triangle"] as const) {
      expect(peak(synthNote(220, 0.05, { type, sampleRate: 8000 }))).toBeGreaterThan(0.3);
    }
    expect(() => synthNote(0, 0.1)).toThrow(/positive/);
    expect(() => synthNote(440, -1)).toThrow(/positive/);
  });
});

describe("sequenceEvents", () => {
  it("converts beats at tempo to seconds with staccato gaps", () => {
    const ev = sequenceEvents(
      [{ beat: 0, freq: 440, beats: 1 }, { beat: 1, freq: 660, beats: 2 }],
      120
    );
    expect(ev[0]).toEqual({ start: 0, freq: 440, dur: 0.45 });
    expect(ev[1]).toEqual({ start: 0.5, freq: 660, dur: 0.9 });
  });

  it("rejects bad tempo and notes", () => {
    expect(() => sequenceEvents([], 0)).toThrow(/bpm/);
    expect(() => sequenceEvents([{ beat: -1, freq: 440, beats: 1 }], 120)).toThrow(/beat/);
  });
});
