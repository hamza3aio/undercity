import { describe, expect, it } from "vitest";
import { skyAt } from "../src/rendering/sky.js";
import { InputActions } from "../src/input/actions.js";
import type { Input } from "../src/input/input.js";

describe("sky palette", () => {
  it("is night at midnight and day at noon", () => {
    expect(skyAt(0).lamp).toBe(1);
    expect(skyAt(12).lamp).toBe(0);
    expect(skyAt(12).sunI).toBeGreaterThan(skyAt(0).sunI);
  });

  it("emits valid RGB triples", () => {
    for (const h of [0, 5, 7, 12, 17, 19, 22]) {
      const f = skyAt(h);
      for (const c of [f.sky, f.fog, f.sunColor]) {
        expect(c).toHaveLength(3);
        for (const v of c) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1.2);
        }
      }
    }
  });
});

describe("InputActions", () => {
  it("maps keys to move axes and buttons", () => {
    const down = new Set(["KeyW", "KeyD", "Space"]);
    const fake = {
      down: (code: string) => down.has(code),
      axis: (neg: string, pos: string) => (down.has(pos) ? 1 : 0) - (down.has(neg) ? 1 : 0),
    } as unknown as Input;
    const a = new InputActions(fake);
    expect(a.move()).toEqual({ x: 1, z: 1 });
    expect(a.jump()).toBe(true);
    expect(a.reset()).toBe(false);
  });
});
