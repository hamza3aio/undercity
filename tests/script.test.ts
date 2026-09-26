import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { makeTransform } from "../src/ecs/components.js";
import type { Transform } from "../src/ecs/components.js";
import { LuaVM } from "../src/script/lua.js";
import { ScriptRuntime } from "../src/script/script.js";

function actor(world: World, x = 0, y = 0, z = 0): number {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  return e;
}

describe("LuaVM", () => {
  it("loads table-returning chunks", () => {
    const vm = new LuaVM();
    const r = vm.load(`return { speed = 5, name = "bot", active = true }`, "t");
    expect(r.ok).toBe(true);
    expect(vm.getScalar(r.ref!, "speed")).toBe(5);
    expect(vm.getScalar(r.ref!, "name")).toBe("bot");
    expect(vm.getScalar(r.ref!, "active")).toBe(true);
    expect(vm.getScalar(r.ref!, "missing")).toBeUndefined();
    expect(vm.readVars(r.ref!)).toEqual({ speed: 5, name: "bot", active: true });
  });

  it("rejects non-table chunks and syntax errors without throwing", () => {
    const vm = new LuaVM();
    expect(vm.load(`return 42`, "t").ok).toBe(false);
    const bad = vm.load(`this is not lua (((`, "t");
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });

  it("sandboxes dangerous globals", () => {
    const vm = new LuaVM();
    const r = vm.load(
      `return { hasDofile = dofile ~= nil, hasIO = io ~= nil, hasOS = os ~= nil,
                hasRequire = require ~= nil, hasLoad = load ~= nil, hasMath = math ~= nil,
                sum = 1 + 2 }`, "t");
    expect(r.ok).toBe(true);
    const vars = vm.readVars(r.ref!);
    expect(vars).toMatchObject({ hasDofile: false, hasIO: false, hasOS: false, hasRequire: false, hasLoad: false, hasMath: true, sum: 3 });
  });

  it("captures print output", () => {
    const vm = new LuaVM();
    vm.load(`print("hello", 42) return {}`, "t");
    expect(vm.logs).toEqual(["hello\t42"]);
  });

  it("setVar round-trips through getScalar", () => {
    const vm = new LuaVM();
    const r = vm.load(`return { speed = 1 }`, "t");
    vm.setField(r.ref!, "speed", 9);
    expect(vm.getScalar(r.ref!, "speed")).toBe(9);
  });
});

describe("ScriptRuntime", () => {
  it("runs start once and update per frame with dt", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world);
    const ok = rt.attach(e, `
      local S = { ticks = 0 }
      function S.start(api, dt) S.ticks = S.ticks + 100 end
      function S.update(api, dt) S.ticks = S.ticks + dt end
      return S`, "counter");
    expect(ok).toBe(true);
    expect(rt.getVars(e).ticks).toBe(100);
    rt.update(0.5);
    rt.update(0.5);
    expect(rt.getVars(e).ticks).toBe(101);
    expect(rt.errors).toEqual([]);
  });

  it("drives transforms through the api", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world, 1, 2, 3);
    rt.attach(e, `
      return {
        update = function(api, dt) api.moveBy(dt * 2, 0, 0) api.setRotY(1.5) end,
      }`, "mover");
    rt.update(0.5);
    const t = world.get<Transform>(e, "transform")!;
    expect(t.position.x).toBeCloseTo(2);
    expect(t.rotationY).toBeCloseTo(1.5);
    expect(rt.getVars(e)).toEqual({});
  });

  it("isolates runtime errors per entity and keeps going", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const bad = actor(world);
    const good = actor(world);
    expect(rt.attach(bad, `return { update = function(api, dt) explode() end }`, "bad")).toBe(true);
    expect(rt.attach(good, `local S = { n = 0 } function S.update(api, dt) S.n = S.n + 1 end return S`, "good")).toBe(true);
    rt.update(0.1);
    rt.update(0.1);
    expect(rt.errors.length).toBeGreaterThan(0);
    expect(rt.errors[0].entity).toBe(bad);
    expect(rt.getVars(good).n).toBe(2);
  });

  it("rejects bad chunks and dead entities", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world);
    expect(rt.attach(e, `return { update = oops( }`, "bad")).toBe(false);
    expect(rt.count()).toBe(0);
    const dead = world.create();
    world.destroy(dead);
    expect(rt.attach(dead, `return {}`, "x")).toBe(false);
  });

  it("get/set vars and reload resets state", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world);
    rt.attach(e, `return { speed = 3 }`, "v");
    expect(rt.getVars(e)).toMatchObject({ speed: 3 });
    expect(rt.setVar(e, "speed", 7)).toBe(true);
    expect(rt.getVars(e).speed).toBe(7);
    expect(rt.setVar(9999, "speed", 1)).toBe(false);
    expect(rt.reload(e, `return { speed = 100 }`)).toBe(true);
    expect(rt.getVars(e).speed).toBe(100);
  });

  it("dispatches onCollide to both sides", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const a = actor(world);
    const b = actor(world);
    rt.attach(a, `local S = { hits = -1 } function S.onCollide(api, other) S.hits = other end return S`, "a");
    rt.attach(b, `return {}`, "b");
    rt.dispatchCollide(a, b);
    expect(rt.getVars(a).hits).toBe(b);
    expect(rt.errors).toEqual([]);
  });

  it("prunes scripts of destroyed entities", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world);
    rt.attach(e, `return { update = function(api, dt) end }`, "x");
    expect(rt.count()).toBe(1);
    world.destroy(e);
    rt.update(0.1);
    expect(rt.count()).toBe(0);
  });

  it("runs waitSeconds coroutines across frames", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world);
    rt.attach(e, `
      local S = { fired = 0 }
      function S.start(api, dt) api.co("later") end
      function S.later(api)
        waitSeconds(1.0)
        S.fired = 1
      end
      return S`, "co");
    rt.update(0.4);
    expect(rt.getVars(e).fired ?? 0).toBe(0);
    rt.update(0.4);
    expect(rt.getVars(e).fired ?? 0).toBe(0);
    rt.update(0.4); // t=1.2 > wakeAt 1.0
    expect(rt.getVars(e).fired).toBe(1);
    expect(rt.errors).toEqual([]);
  });

  it("records coroutine errors without killing the loop", () => {
    const world = new World();
    const rt = new ScriptRuntime(world);
    const e = actor(world);
    rt.attach(e, `
      return {
        start = function(api, dt) api.co("boom") end,
        boom = function(api) waitSeconds(0.1) explode() end,
      }`, "coerr");
    rt.update(0.05);
    rt.update(0.2);
    expect(rt.errors.length).toBeGreaterThan(0);
    rt.update(0.5); // loop survives; coro is gone
    expect(rt.count()).toBe(1);
  });
});
