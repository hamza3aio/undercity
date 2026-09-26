// Glitch samples — pure PCM data, WAV codec, mixdown. No AudioContext here
// on purpose: everything in this file runs headless (tests) and in browsers.
// Playback lives in audio.ts (AudioEngine.playSample / playBuffer).

export interface SampleClip {
  sampleRate: number;
  channels: Float32Array[]; // deinterleaved, mono = 1 entry
}

export function clipLength(clip: SampleClip): number {
  return clip.channels.length === 0 ? 0 : clip.channels[0].length;
}

export function clipDuration(clip: SampleClip): number {
  return clipLength(clip) / clip.sampleRate;
}

function readAscii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// Minimal WAV decoder: PCM 16/24/32-bit int + 32-bit float, any channel
// count, 8k–96kHz. Skips unknown subchunks (LIST, fact, ...). Throws
// descriptive errors on malformed/unsupported data (never silent).
export function decodeWav(buffer: ArrayBuffer): SampleClip {
  const view = new DataView(buffer);
  if (view.byteLength < 44) throw new Error("decodeWav: file too small for a WAV header");
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("decodeWav: not a RIFF/WAVE file");
  }
  let offset = 12;
  let format = -1;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true); // bits-per-sample sits after byteRate+blockAlign
    } else if (id === "data") {
      dataStart = offset + 8;
      dataLen = size;
      break; // data is conventionally last; stop scanning
    }
    offset += 8 + size + (size % 2); // word-aligned chunks
  }
  if (format !== 1 && format !== 3) {
    throw new Error(`decodeWav: unsupported format ${format} (need PCM int or float)`);
  }
  if (format === 3 && bits !== 32) throw new Error("decodeWav: float WAV must be 32-bit");
  if (![8, 16, 24, 32].includes(bits)) {
    throw new Error(`decodeWav: unsupported bit depth ${bits}`);
  }
  if (channels < 1 || channels > 32) throw new Error(`decodeWav: bad channel count ${channels}`);
  if (sampleRate < 8000 || sampleRate > 96000) throw new Error(`decodeWav: bad sample rate ${sampleRate}`);
  if (dataStart < 0) throw new Error("decodeWav: missing data chunk");
  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  if (frames <= 0) throw new Error("decodeWav: empty data chunk");
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  let p = dataStart;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let v: number;
      if (format === 3) {
        v = view.getFloat32(p, true);
      } else if (bits === 8) {
        v = (view.getUint8(p) - 128) / 128; // offset binary
      } else if (bits === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        const b0 = view.getUint8(p), b1 = view.getUint8(p + 1), b2 = view.getUint8(p + 2);
        let s = (b2 << 16) | (b1 << 8) | b0;
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608;
      } else {
        v = view.getInt32(p, true) / 2147483648;
      }
      out[c][f] = Math.max(-1, Math.min(1, v));
      p += bytesPerSample;
    }
  }
  return { sampleRate, channels: out };
}

// 16-bit PCM WAV writer (mono/stereo+). Round-trips decodeWav().
export function encodeWav(clip: SampleClip): ArrayBuffer {
  const channels = clip.channels.length;
  if (channels === 0) throw new Error("encodeWav: no channels");
  const frames = clipLength(clip);
  const dataBytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, clip.sampleRate, true);
  view.setUint32(28, clip.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  let p = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, clip.channels[c][f]));
      view.setInt16(p, Math.round(v * 32767), true);
      p += 2;
    }
  }
  return buf;
}

export interface MixLayer {
  clip: SampleClip;
  atSeconds: number;
  gain?: number;
}

// Sum layers starting at offsets; output clamped to [-1, 1]. All layers must
// share the sample rate (throws otherwise — no silent resampling).
export function mixdown(layers: MixLayer[], sampleRate: number): SampleClip {
  if (layers.length === 0) return { sampleRate, channels: [new Float32Array(0)] };
  for (const l of layers) {
    if (l.clip.sampleRate !== sampleRate) {
      throw new Error(`mixdown: rate mismatch ${l.clip.sampleRate} != ${sampleRate}`);
    }
  }
  let frames = 0;
  for (const l of layers) {
    frames = Math.max(frames, Math.floor(l.atSeconds * sampleRate) + clipLength(l.clip));
  }
  const out = new Float32Array(frames);
  for (const l of layers) {
    const g = l.gain ?? 1;
    const start = Math.floor(l.atSeconds * sampleRate);
    const src = l.clip.channels[0] ?? new Float32Array(0);
    for (let i = 0; i < src.length; i++) out[start + i] += src[i] * g;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
  return { sampleRate, channels: [out] };
}
