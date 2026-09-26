// Glitch action maps — named actions (Move/Jump/Shoot/Interact/Pause…)
// instead of hardcoded keys. Buttons, 1D axes, 2D vectors; per-context
// bindings with global fallback; rebindable; serializable. Gamepad input is
// injected (defaults to a guarded navigator poll) so everything except live
// pads runs headless in tests.

export interface RawState {
  down(code: string): boolean;
  pressed: Set<string>;
  released: Set<string>;
}

export interface PadState {
  buttons: boolean[];
  axes: number[];
}

export interface ButtonDef {
  kind: "button";
  keys: string[];
  pad?: number[];
}

export interface AxisDef {
  kind: "axis";
  neg: string[];
  pos: string[];
  padAxis?: number;
  padInvert?: boolean;
  deadzone?: number;
}

export interface VectorDef {
  kind: "vector";
  left: string[];
  right: string[];
  up: string[];
  down: string[];
}

export type ActionDef = ButtonDef | AxisDef | VectorDef;

export const GLOBAL_CONTEXT = "global";

function anyDown(raw: RawState, codes: string[]): boolean {
  for (const c of codes) if (raw.down(c)) return true;
  return false;
}

function anyPressed(raw: RawState, codes: string[]): boolean {
  for (const c of codes) if (raw.pressed.has(c)) return true;
  return false;
}

function anyReleased(raw: RawState, codes: string[]): boolean {
  for (const c of codes) if (raw.released.has(c)) return true;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  return v as string[];
}

function numArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "number" && isFinite(x))) return null;
  return v as number[];
}

export class ActionMap {
  private defs = new Map<string, ActionDef>(); // "context:name" -> def
  private context: string = GLOBAL_CONTEXT;

  constructor(
    private raw: RawState,
    private opts: { padSource?: () => (PadState | null | undefined)[]; padIndex?: number } = {}
  ) {}

  setContext(name: string): void {
    this.context = name;
  }

  getContext(): string {
    return this.context;
  }

  private key(name: string, context?: string): string {
    return `${context ?? this.context}:${name}`;
  }

  private lookup(name: string): ActionDef {
    const scoped = this.defs.get(this.key(name));
    if (scoped) return scoped;
    const global = this.defs.get(`${GLOBAL_CONTEXT}:${name}`);
    if (global) return global;
    throw new Error(`ActionMap: undefined action "${name}" (context "${this.context}")`);
  }

  defineButton(name: string, def: Omit<ButtonDef, "kind">, context = GLOBAL_CONTEXT): void {
    this.defs.set(this.key(name, context), { kind: "button", keys: [...def.keys], pad: def.pad ? [...def.pad] : undefined });
  }

  defineAxis(name: string, def: Omit<AxisDef, "kind">, context = GLOBAL_CONTEXT): void {
    this.defs.set(this.key(name, context), {
      kind: "axis",
      neg: [...def.neg], pos: [...def.pos],
      padAxis: def.padAxis, padInvert: def.padInvert,
      deadzone: def.deadzone ?? 0.2,
    });
  }

  defineVector(name: string, def: Omit<VectorDef, "kind">, context = GLOBAL_CONTEXT): void {
    this.defs.set(this.key(name, context), {
      kind: "vector",
      left: [...def.left], right: [...def.right], up: [...def.up], down: [...def.down],
    });
  }

  remove(name: string, context?: string): boolean {
    return this.defs.delete(this.key(name, context));
  }

  rebind(name: string, def: Omit<ButtonDef, "kind"> | Omit<AxisDef, "kind"> | Omit<VectorDef, "kind">, context?: string): void {
    const key = this.key(name, context);
    const cur = this.defs.get(key) ?? this.defs.get(`${GLOBAL_CONTEXT}:${name}`);
    if (!cur) throw new Error(`ActionMap: cannot rebind undefined action "${name}"`);
    if (cur.kind === "button") this.defineButton(name, def as Omit<ButtonDef, "kind">, context ?? this.contextOf(key));
    else if (cur.kind === "axis") this.defineAxis(name, def as Omit<AxisDef, "kind">, context ?? this.contextOf(key));
    else this.defineVector(name, def as Omit<VectorDef, "kind">, context ?? this.contextOf(key));
  }

  private contextOf(key: string): string {
    return key.slice(0, key.indexOf(":"));
  }

  private pad(): PadState | null {
    return this.cached;
  }

  private padDown(btns: number[] | undefined, pad: PadState | null): boolean {
    if (!pad || !btns) return false;
    return btns.some((b) => pad.buttons[b] === true);
  }

  // Polls pads and shifts edge state. Call ONCE per frame, before queries;
  // keyboard edges come from RawState independently. Cached poll keeps every
  // query within the frame consistent.
  private cached: PadState | null = null;
  private prev: boolean[] = [];

  update(): void {
    this.prev = this.cached?.buttons ?? [];
    let next: PadState | null = null;
    try {
      const src = this.opts.padSource ?? defaultPadSource;
      const p = src()[this.opts.padIndex ?? 0];
      if (p) next = { buttons: p.buttons.map((b) => b === true), axes: [...p.axes] };
    } catch {
      next = null;
    }
    this.cached = next;
  }

  private padPressed(btns: number[] | undefined, pad: PadState | null): boolean {
    if (!pad || !btns) return false;
    return btns.some((b) => pad.buttons[b] === true && this.prev[b] !== true);
  }

  private padReleased(btns: number[] | undefined, pad: PadState | null): boolean {
    if (!pad || !btns) return false;
    return btns.some((b) => pad.buttons[b] !== true && this.prev[b] === true);
  }

  down(name: string): boolean {
    const def = this.lookup(name);
    if (def.kind !== "button") throw new Error(`ActionMap: "${name}" is not a button`);
    return anyDown(this.raw, def.keys) || this.padDown(def.pad, this.pad());
  }

  pressed(name: string): boolean {
    const def = this.lookup(name);
    if (def.kind !== "button") throw new Error(`ActionMap: "${name}" is not a button`);
    if (anyPressed(this.raw, def.keys)) return true;
    return this.padPressed(def.pad, this.pad());
  }

  released(name: string): boolean {
    const def = this.lookup(name);
    if (def.kind !== "button") throw new Error(`ActionMap: "${name}" is not a button`);
    if (anyReleased(this.raw, def.keys)) return true;
    return this.padReleased(def.pad, this.pad());
  }

  axis(name: string): number {
    const def = this.lookup(name);
    if (def.kind !== "axis") throw new Error(`ActionMap: "${name}" is not an axis`);
    let v = (anyDown(this.raw, def.pos) ? 1 : 0) - (anyDown(this.raw, def.neg) ? 1 : 0);
    const pad = this.pad();
    if (pad && def.padAxis !== undefined) {
      const raw = pad.axes[def.padAxis] ?? 0;
      const dz = def.deadzone ?? 0.2;
      const pv = Math.abs(raw) < dz ? 0 : (raw - Math.sign(raw) * dz) / (1 - dz);
      v += (def.padInvert ? -pv : pv);
    }
    return Math.max(-1, Math.min(1, v));
  }

  vector(name: string): { x: number; y: number } {
    const def = this.lookup(name);
    if (def.kind !== "vector") throw new Error(`ActionMap: "${name}" is not a vector`);
    const x = (anyDown(this.raw, def.right) ? 1 : 0) - (anyDown(this.raw, def.left) ? 1 : 0);
    const y = (anyDown(this.raw, def.up) ? 1 : 0) - (anyDown(this.raw, def.down) ? 1 : 0);
    return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  toJSON(): string {
    const bindings: Record<string, ActionDef> = {};
    for (const [k, def] of this.defs) bindings[k] = def;
    return JSON.stringify({ version: 1, context: this.context, bindings });
  }

  // Returns number of skipped invalid entries. Throws on malformed JSON.
  loadJSON(json: string): number {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      throw new Error(`ActionMap: malformed JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!isRecord(raw) || !isRecord(raw.bindings)) {
      throw new Error("ActionMap: expected { bindings: {...} }");
    }
    let skipped = 0;
    for (const [key, def] of Object.entries(raw.bindings)) {
      if (!key.includes(":") || !this.validDef(def)) {
        skipped++;
        continue;
      }
      this.defs.set(key, def);
    }
    if (typeof raw.context === "string") this.context = raw.context;
    return skipped;
  }

  private validDef(def: unknown): def is ActionDef {
    if (!isRecord(def) || typeof def.kind !== "string") return false;
    if (def.kind === "button") {
      return strArray(def.keys) !== null && (def.pad === undefined || numArray(def.pad) !== null);
    }
    if (def.kind === "axis") {
      return strArray(def.neg) !== null && strArray(def.pos) !== null &&
        (def.padAxis === undefined || typeof def.padAxis === "number") &&
        (def.padInvert === undefined || typeof def.padInvert === "boolean") &&
        (def.deadzone === undefined || typeof def.deadzone === "number");
    }
    if (def.kind === "vector") {
      return strArray(def.left) !== null && strArray(def.right) !== null &&
        strArray(def.up) !== null && strArray(def.down) !== null;
    }
    return false;
  }
}

function defaultPadSource(): (PadState | null | undefined)[] {
  try {
    const nav = (globalThis as Record<string, unknown>).navigator as
      | { getGamepads?: () => (Gamepad | null)[] }
      | undefined;
    if (!nav || typeof nav.getGamepads !== "function") return [];
    return nav.getGamepads().map((g) =>
      g ? { buttons: g.buttons.map((b) => b.pressed), axes: [...g.axes] } : null
    );
  } catch {
    return [];
  }
}
