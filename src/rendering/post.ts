// Glitch post-processing — pass graph, CPU reference math, LUT baking.
// Passes are plain JSON-safe data so chains persist in scene files.
// The GPU composite (POST_FRAG_SRC in shader.ts) mirrors gradePixel +
// vignetteFactor; the tests below pin the CPU equations. The framebuffer
// capture + composite path in renderer.ts needs browser confirmation.

export interface GradeOpts {
  exposure: number; // EV stops, -4..4 (0 = neutral)
  contrast: number; // 0..2, pivot 0.5 (1 = neutral)
  saturation: number; // 0..2 (1 = neutral)
}

export interface VignetteOpts {
  strength: number; // 0..1 (0 = off)
}

export type PostPassKind = "grade" | "vignette";

export interface GradePass {
  kind: "grade";
  grade: GradeOpts;
}

export interface VignettePass {
  kind: "vignette";
  vignette: VignetteOpts;
}

export type PostPass = GradePass | VignettePass;

export function defaultGrade(): GradeOpts {
  return { exposure: 0, contrast: 1, saturation: 1 };
}

export function defaultVignette(): VignetteOpts {
  return { strength: 0.35 };
}

function finite(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`post: ${name} must be a finite number`);
  }
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function sanitizeGrade(g: GradeOpts): GradeOpts {
  return {
    exposure: clamp(finite(g.exposure, "exposure"), -4, 4),
    contrast: clamp(finite(g.contrast, "contrast"), 0, 2),
    saturation: clamp(finite(g.saturation, "saturation"), 0, 2),
  };
}

export function sanitizeVignette(v: VignetteOpts): VignetteOpts {
  return { strength: clamp(finite(v.strength, "strength"), 0, 1) };
}

// Luma weights (Rec. 709) shared by the CPU path and the composite shader.
export const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722];

// Reference color grade: exposure (2^ev) -> contrast about mid-gray ->
// saturation toward luma. Output clamped to [0, 1].
export function gradePixel(
  r: number, g: number, b: number, o: GradeOpts
): [number, number, number] {
  const m = Math.pow(2, o.exposure);
  let cr = r * m, cg = g * m, cb = b * m;
  cr = (cr - 0.5) * o.contrast + 0.5;
  cg = (cg - 0.5) * o.contrast + 0.5;
  cb = (cb - 0.5) * o.contrast + 0.5;
  const luma = cr * LUMA[0] + cg * LUMA[1] + cb * LUMA[2];
  cr = luma + (cr - luma) * o.saturation;
  cg = luma + (cg - luma) * o.saturation;
  cb = luma + (cb - luma) * o.saturation;
  return [clamp(cr, 0, 1), clamp(cg, 0, 1), clamp(cb, 0, 1)];
}

// Vignette falloff. nx/ny are centered UVs in [-1, 1]; 1 at center,
// darkening toward corners. strength 0 disables (always 1).
export function vignetteFactor(nx: number, ny: number, strength: number): number {
  if (!(strength > 0)) return 1;
  const d = Math.hypot(nx, ny) / Math.SQRT2; // 0 center .. ~1 corner
  return clamp(1 - strength * d * d, 0, 1);
}

// Precomputed 3D grade LUT (size^3 RGB entries). Neutral options bake an
// identity LUT. size must be an integer >= 2.
export function bakeGradeLUT(size: number, o: GradeOpts): Float32Array {
  if (!Number.isInteger(size) || size < 2) {
    throw new Error("bakeGradeLUT: size must be an integer >= 2");
  }
  const lut = new Float32Array(size * size * size * 3);
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = gradePixel(ri / (size - 1), gi / (size - 1), bi / (size - 1), o);
        const k = (bi * size * size + gi * size + ri) * 3;
        lut[k] = r; lut[k + 1] = g; lut[k + 2] = b;
      }
    }
  }
  return lut;
}

// Trilinear LUT sample. Inputs clamped to [0, 1].
export function sampleLUT(
  lut: Float32Array, size: number, r: number, g: number, b: number
): [number, number, number] {
  const at = (ri: number, gi: number, bi: number): [number, number, number] => {
    const k = (bi * size * size + gi * size + ri) * 3;
    return [lut[k], lut[k + 1], lut[k + 2]];
  };
  const fx = clamp(r, 0, 1) * (size - 1);
  const fy = clamp(g, 0, 1) * (size - 1);
  const fz = clamp(b, 0, 1) * (size - 1);
  const x0 = Math.min(size - 2, Math.floor(fx)), y0 = Math.min(size - 2, Math.floor(fy)), z0 = Math.min(size - 2, Math.floor(fz));
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const c000 = at(x0, y0, z0), c100 = at(x0 + 1, y0, z0);
  const c010 = at(x0, y0 + 1, z0), c110 = at(x0 + 1, y0 + 1, z0);
  const c001 = at(x0, y0, z0 + 1), c101 = at(x0 + 1, y0, z0 + 1);
  const c011 = at(x0, y0 + 1, z0 + 1), c111 = at(x0 + 1, y0 + 1, z0 + 1);
  const lerp = (a: number, b2: number, t: number) => a + (b2 - a) * t;
  const mix = (a: [number, number, number], b2: [number, number, number], t: number): [number, number, number] =>
    [lerp(a[0], b2[0], t), lerp(a[1], b2[1], t), lerp(a[2], b2[2], t)];
  return mix(
    mix(mix(c000, c100, tx), mix(c010, c110, tx), ty),
    mix(mix(c001, c101, tx), mix(c011, c111, tx), ty),
    tz
  );
}

export interface PostUniforms {
  exposure: number;
  contrast: number;
  saturation: number;
  vignette: number;
}

export function neutralUniforms(): PostUniforms {
  return { exposure: 0, contrast: 1, saturation: 1, vignette: 0 };
}

// Ordered, serializable pass chain. When several passes share a kind, the
// LAST one wins for the single-pass composite shader (documented).
export class PostChain {
  enabled = false;
  passes: PostPass[] = [];
  width = 0;
  height = 0;

  get count(): number {
    return this.passes.length;
  }

  kinds(): PostPassKind[] {
    return this.passes.map((p) => p.kind);
  }

  add(kind: PostPassKind): number {
    if (kind === "grade") this.passes.push({ kind, grade: defaultGrade() });
    else if (kind === "vignette") this.passes.push({ kind, vignette: defaultVignette() });
    else throw new Error(`post: unknown pass kind "${String(kind)}"`);
    return this.passes.length - 1;
  }

  remove(i: number): boolean {
    if (!Number.isInteger(i) || i < 0 || i >= this.passes.length) return false;
    this.passes.splice(i, 1);
    return true;
  }

  move(from: number, to: number): boolean {
    const n = this.passes.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [p] = this.passes.splice(from, 1);
    this.passes.splice(to, 0, p);
    return true;
  }

  setGrade(i: number, partial: Partial<GradeOpts>): boolean {
    const p = this.passes[i];
    if (!p || p.kind !== "grade") return false;
    p.grade = sanitizeGrade({ ...p.grade, ...partial });
    return true;
  }

  setVignette(i: number, partial: Partial<VignetteOpts>): boolean {
    const p = this.passes[i];
    if (!p || p.kind !== "vignette") return false;
    p.vignette = sanitizeVignette({ ...p.vignette, ...partial });
    return true;
  }

  clear(): void {
    this.passes.length = 0;
  }

  resize(w: number, h: number): void {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      throw new Error("post: resize dimensions must be positive integers");
    }
    this.width = w;
    this.height = h;
  }

  uniforms(): PostUniforms {
    const u = neutralUniforms();
    for (const p of this.passes) {
      if (p.kind === "grade") {
        u.exposure = p.grade.exposure;
        u.contrast = p.grade.contrast;
        u.saturation = p.grade.saturation;
      } else {
        u.vignette = p.vignette.strength;
      }
    }
    return u;
  }

  toJSON(): { enabled: boolean; passes: PostPass[] } {
    return {
      enabled: this.enabled,
      passes: this.passes.map((p) =>
        p.kind === "grade"
          ? { kind: "grade" as const, grade: { ...p.grade } }
          : { kind: "vignette" as const, vignette: { ...p.vignette } }
      ),
    };
  }

  static fromJSON(data: unknown): PostChain {
    const c = new PostChain();
    if (typeof data !== "object" || data === null) throw new Error("post: chain JSON must be an object");
    const d = data as { enabled?: unknown; passes?: unknown };
    c.enabled = d.enabled === true;
    if (!Array.isArray(d.passes)) throw new Error("post: chain JSON needs a passes array");
    for (const p of d.passes) {
      if (typeof p !== "object" || p === null) throw new Error("post: pass must be an object");
      const kind = (p as { kind?: unknown }).kind;
      if (kind === "grade") {
        const g = (p as { grade?: unknown }).grade;
        if (typeof g !== "object" || g === null) throw new Error("post: grade pass needs grade options");
        c.passes.push({ kind: "grade", grade: sanitizeGrade({ ...defaultGrade(), ...(g as GradeOpts) }) });
      } else if (kind === "vignette") {
        const v = (p as { vignette?: unknown }).vignette;
        if (typeof v !== "object" || v === null) throw new Error("post: vignette pass needs vignette options");
        c.passes.push({ kind: "vignette", vignette: sanitizeVignette({ ...defaultVignette(), ...(v as VignetteOpts) }) });
      } else {
        throw new Error(`post: unknown pass kind "${String(kind)}"`);
      }
    }
    return c;
  }
}
