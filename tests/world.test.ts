import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";

describe("World", () => {
  it("creates, tracks liveness, and destroys entities", () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    expect(w.isAlive(a)).toBe(true);
    expect(w.count()).toBe(2);
    w.destroy(a);
    expect(w.isAlive(a)).toBe(false);
    expect(w.isAlive(b)).toBe(true);
    expect(w.count()).toBe(1);
  });

  it("stores, queries and removes components", () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    w.add(a, "health", { hp: 10 });
    w.add(a, "pos", { x: 1 });
    w.add(b, "health", { hp: 5 });
    expect(w.get<{ hp: number }>(a, "health")).toEqual({ hp: 10 });
    expect(w.query("health")).toHaveLength(2);
    expect(w.query("health", "pos")).toEqual([a]);
    w.remove(a, "pos");
    expect(w.query("health", "pos")).toEqual([]);
  });

  it("destroy drops every component store entry", () => {
    const w = new World();
    const a = w.create();
    w.add(a, "x", 1);
    w.destroy(a);
    expect(w.has(a, "x")).toBe(false);
    expect(w.query("x")).toEqual([]);
  });
});
