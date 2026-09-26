import { describe, expect, it } from "vitest";
import { ActionMap, type PadState, type RawState } from "../src/input/actionmap.js";
import { InputActions } from "../src/input/actions.js";
import type { Input } from "../src/input/input.js";

// Scripted keyboard state. Each test drives "frames" by mutating sets.
class FakeRaw implements RawState {
  downSet = new Set<string>();
  pressed = new Set<string>();
  released = new Set<string>();

  down(code: string) { return this.downSet.has(code); }

  frame(down: string[] = [], pressed: string[] = [], released: string[] = []) {
    this.downSet = new Set(down);
    this.pressed = new Set(pressed);
    this.released = new Set(released);
  }
}

function padSource(states: (PadState | null)[]) {
  let i = 0;
  return () => [states[Math.min(i++, states.length - 1)] ?? null];
}

describe("ActionMap buttons", () => {
  it("down/pressed/released from keys", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineButton("jump", { keys: ["Space"] });
    raw.frame([], []);
    expect(map.down("jump")).toBe(false);
    expect(map.pressed("jump")).toBe(false);
    raw.frame(["Space"], ["Space"]);
    expect(map.down("jump")).toBe(true);
    expect(map.pressed("jump")).toBe(true);
    expect(map.released("jump")).toBe(false);
    raw.frame([], [], ["Space"]);
    expect(map.down("jump")).toBe(false);
    expect(map.released("jump")).toBe(true);
  });

  it("throws on undefined or mistyped actions", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineButton("jump", { keys: ["Space"] });
    expect(() => map.down("nope")).toThrow(/undefined action/);
    expect(() => map.axis("jump")).toThrow(/not an axis/);
    expect(() => map.rebind("nope", { keys: ["X"] })).toThrow(/undefined action/);
  });

  it("rebinds keys", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineButton("jump", { keys: ["Space"] });
    map.rebind("jump", { keys: ["KeyJ"] });
    raw.frame(["Space"], ["Space"]);
    expect(map.down("jump")).toBe(false);
    raw.frame(["KeyJ"], ["KeyJ"]);
    expect(map.down("jump")).toBe(true);
  });
});

describe("ActionMap axes and vectors", () => {
  it("combines opposite keys and clamps", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineAxis("throttle", { neg: ["KeyS"], pos: ["KeyW"] });
    raw.frame(["KeyW"]);
    expect(map.axis("throttle")).toBe(1);
    raw.frame(["KeyW", "KeyS"]);
    expect(map.axis("throttle")).toBe(0);
    raw.frame(["KeyS"]);
    expect(map.axis("throttle")).toBe(-1);
  });

  it("builds 2D vectors", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineVector("move", { left: ["KeyA"], right: ["KeyD"], up: ["KeyW"], down: ["KeyS"] });
    raw.frame(["KeyD", "KeyW"]);
    expect(map.vector("move")).toEqual({ x: 1, y: 1 });
  });
});

describe("ActionMap contexts", () => {
  it("prefers the active context, falls back to global", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineButton("jump", { keys: ["Space"] }); // global
    map.defineButton("jump", { keys: ["KeyJ"] }, "menu");
    raw.frame(["Space"], ["Space"]);
    expect(map.pressed("jump")).toBe(true); // global
    map.setContext("menu");
    raw.frame(["Space"], ["Space"]);
    expect(map.pressed("jump")).toBe(false); // shadowed by menu binding
    raw.frame(["KeyJ"], ["KeyJ"]);
    expect(map.pressed("jump")).toBe(true);
    expect(map.getContext()).toBe("menu");
  });
});

describe("ActionMap gamepad", () => {
  it("maps buttons with edges across update() frames", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw, {
      padSource: padSource([
        { buttons: [false, false], axes: [] },
        { buttons: [false, true], axes: [] },
        { buttons: [false, true], axes: [] },
        { buttons: [false, false], axes: [] },
      ]),
    });
    map.defineButton("fire", { keys: [], pad: [1] });
    map.update(); // frame 1: released
    expect(map.down("fire")).toBe(false);
    map.update(); // frame 2: pressed edge
    expect(map.down("fire")).toBe(true);
    expect(map.pressed("fire")).toBe(true);
    map.update(); // frame 3: held, no edge
    expect(map.down("fire")).toBe(true);
    expect(map.pressed("fire")).toBe(false);
    map.update(); // frame 4: released edge
    expect(map.down("fire")).toBe(false);
    expect(map.released("fire")).toBe(true);
  });

  it("applies deadzone and invert on stick axes", () => {
    const raw = new FakeRaw();
    const mk = (axes: number[]) => new ActionMap(raw, { padSource: padSource([{ buttons: [], axes }]) });
    const m1 = mk([0.1]);
    m1.defineAxis("x", { neg: [], pos: [], padAxis: 0 });
    m1.update();
    expect(m1.axis("x")).toBe(0); // inside deadzone
    const m2 = mk([0.6]);
    m2.defineAxis("x", { neg: [], pos: [], padAxis: 0 });
    m2.update();
    expect(m2.axis("x")).toBeCloseTo((0.6 - 0.2) / 0.8, 3);
    const m3 = mk([0.6]);
    m3.defineAxis("x", { neg: [], pos: [], padAxis: 0, padInvert: true });
    m3.update();
    expect(m3.axis("x")).toBeLessThan(0);
  });

  it("keyboard and pad sum clamped on axes", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw, { padSource: padSource([{ buttons: [], axes: [0.6] }]) });
    map.defineAxis("x", { neg: [], pos: ["KeyD"], padAxis: 0 });
    raw.frame(["KeyD"]);
    map.update();
    expect(map.axis("x")).toBe(1); // 1 + 0.5 clamped
  });
});

describe("ActionMap serialization", () => {
  it("round-trips bindings and context, skips invalid entries", () => {
    const raw = new FakeRaw();
    const map = new ActionMap(raw);
    map.defineButton("jump", { keys: ["Space"], pad: [0] });
    map.defineAxis("throttle", { neg: ["KeyS"], pos: ["KeyW"] });
    map.setContext("play");
    const json = map.toJSON();
    const map2 = new ActionMap(raw);
    const skipped = map2.loadJSON(json);
    expect(skipped).toBe(0);
    expect(map2.getContext()).toBe("play");
    raw.frame(["Space"], ["Space"]);
    expect(map2.down("jump")).toBe(true);
    expect(() => map2.loadJSON("nope")).toThrow(/malformed/);
    expect(() => map2.loadJSON("{}")).toThrow(/bindings/);
    expect(map2.loadJSON(JSON.stringify({ bindings: { "x": { kind: "nope" }, "y:nope": 42 } }))).toBe(2);
  });
});

describe("InputActions legacy wrapper", () => {
  it("preserves WASD/arrows/jump/reset semantics", () => {
    const raw = new FakeRaw();
    const a = new InputActions(raw as unknown as Input);
    raw.frame(["KeyW", "KeyD"]);
    expect(a.move()).toEqual({ x: 1, z: 1 });
    raw.frame(["KeyS", "ArrowLeft"]);
    expect(a.move()).toEqual({ x: -1, z: -1 });
    raw.frame(["KeyW", "KeyS"]);
    expect(a.move()).toEqual({ x: 0, z: 0 });
    raw.frame(["Space"]);
    expect(a.jump()).toBe(true);
    raw.frame(["KeyR"]);
    expect(a.reset()).toBe(true);
    expect(a.jump()).toBe(false);
  });
});
