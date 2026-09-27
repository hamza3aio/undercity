// Glitch scripts — Lua gameplay code attached to entities.
// One shared sandboxed VM (lua.ts); each entity owns an exports table +
// an API table plus its coroutines. Lifecycle: start(api, dt=0) once,
// update(api, dt) per frame, onCollide(api, otherId), co("fn") coroutines
// with waitSeconds(). Errors are recorded, never thrown into the game loop
// (max 25 kept). Reloading resets script state (documented).

import { World, type Entity } from "../ecs/world.js";
import type { Transform } from "../ecs/components.js";
import { LuaVM, type LuaScalar } from "./lua.js";

export const SCRIPT_COMPONENT = "script";

export interface ScriptDef {
  source: string;
  name: string;
}

export interface ScriptError {
  entity: Entity;
  message: string;
}

interface Bound {
  table: number;
  api: number;
}

interface Coro {
  handle: number;
  owner: Entity;
  wakeAt: number;
}

export class ScriptRuntime {
  private vm = new LuaVM();
  private bound = new Map<Entity, Bound>();
  private coros: Coro[] = [];
  private time = 0;
  errors: ScriptError[] = [];
  /** Optional hook so a game can surface script errors in its own console. */
  onError: ((err: ScriptError) => void) | null = null;

  constructor(private world: World) {}

  private fail(entity: Entity, message: string): void {
    const record = { entity, message };
    this.errors.push(record);
    if (this.errors.length > 25) this.errors.shift();
    if (this.onError) {
      try {
        this.onError(record);
      } catch {
        // A throwing reporter must not break the frame.
      }
    }
  }

  count(): number {
    return this.bound.size;
  }

  getTime(): number {
    return this.time;
  }

  attach(e: Entity, source: string, name = "script"): boolean {
    if (!this.world.isAlive(e)) return false;
    this.detach(e);
    const loaded = this.vm.load(source, name);
    if (!loaded.ok || loaded.ref === undefined) {
      this.fail(e, loaded.error ?? "load failed");
      return false;
    }
    const api = this.vm.newTable();
    this.buildApi(e, api);
    // Register BEFORE start: start hooks may spawn coroutines via api.co(),
    // which resolves through this binding.
    this.bound.set(e, { table: loaded.ref, api });
    this.world.add(e, SCRIPT_COMPONENT, { source, name } satisfies ScriptDef);
    const started = this.vm.callMethodArgs(loaded.ref, "start", api, [0]);
    if (!started.ok) {
      this.fail(e, started.error ?? "start failed");
      this.detach(e);
      return false;
    }
    return true;
  }

  detach(e: Entity): void {
    const b = this.bound.get(e);
    if (!b) return;
    this.vm.unref(b.api);
    this.vm.unref(b.table);
    this.bound.delete(e);
    this.coros = this.coros.filter((c) => c.owner !== e);
    this.world.remove(e, SCRIPT_COMPONENT);
  }

  reload(e: Entity, source: string): boolean {
    const def = this.world.get<ScriptDef>(e, SCRIPT_COMPONENT);
    const name = def?.name ?? "script";
    this.detach(e);
    return this.attach(e, source, name);
  }

  getVars(e: Entity): Record<string, LuaScalar> {
    const b = this.bound.get(e);
    if (!b) return {};
    return this.vm.readVars(b.table);
  }

  setVar(e: Entity, key: string, value: LuaScalar): boolean {
    const b = this.bound.get(e);
    if (!b) return false;
    this.vm.setField(b.table, key, value);
    return true;
  }

  update(dt: number): void {
    if (!(dt >= 0)) return;
    this.time += dt;
    // Drop scripts whose entities died externally (unrefs included).
    for (const e of [...this.bound.keys()]) {
      if (!this.world.isAlive(e)) this.detach(e);
    }
    for (const [e, b] of this.bound) {
      const r = this.vm.callMethodArgs(b.table, "update", b.api, [dt]);
      if (!r.ok) this.fail(e, r.error ?? "update failed");
    }
    for (const c of [...this.coros]) {
      if (c.wakeAt > this.time) continue;
      if (!this.world.isAlive(c.owner) || !this.bound.has(c.owner)) {
        this.vm.dropThread(c.handle);
        this.coros = this.coros.filter((x) => x !== c);
        continue;
      }
      const st = this.vm.resumeThread(c.handle, dt);
      if (st === "dead") {
        if (this.vm.lastResumeError) this.fail(c.owner, this.vm.lastResumeError);
        this.vm.lastResumeError = null;
        this.coros = this.coros.filter((x) => x !== c);
      } else {
        c.wakeAt = this.time + Math.max(0, this.vm.yieldedNumber(c.handle));
      }
    }
  }

  dispatchCollide(a: Entity, b: Entity): void {
    for (const [self, other] of [[a, b], [b, a]] as const) {
      const bound = this.bound.get(self);
      if (!bound) continue;
      const r = this.vm.callMethodArgs(bound.table, "onCollide", bound.api, [other]);
      if (!r.ok) this.fail(self, r.error ?? "onCollide failed");
    }
  }

  private buildApi(e: Entity, apiRef: number): void {
    const world = this.world;
    const vm = this.vm;
    const runtime = this;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    vm.setField(apiRef, "id", e);
    vm.setFunc(apiRef, "getTime", () => runtime.time);
    vm.setFunc(apiRef, "log", (msg) => {
      vm.logs.push(`[e${e}] ${String(msg)}`);
    });
    vm.setFunc(apiRef, "getX", () => world.get<Transform>(e, "transform")?.position.x ?? 0);
    vm.setFunc(apiRef, "getY", () => world.get<Transform>(e, "transform")?.position.y ?? 0);
    vm.setFunc(apiRef, "getZ", () => world.get<Transform>(e, "transform")?.position.z ?? 0);
    vm.setFunc(apiRef, "setPos", (x, y, z) => {
      world.get<Transform>(e, "transform")?.position.set(num(x), num(y), num(z));
    });
    vm.setFunc(apiRef, "moveBy", (dx, dy, dz) => {
      const t = world.get<Transform>(e, "transform");
      if (t) t.position.set(t.position.x + num(dx), t.position.y + num(dy), t.position.z + num(dz));
    });
    vm.setFunc(apiRef, "getRotY", () => world.get<Transform>(e, "transform")?.rotationY ?? 0);
    vm.setFunc(apiRef, "setRotY", (ry) => {
      const t = world.get<Transform>(e, "transform");
      if (t) t.rotationY = num(ry);
    });
    vm.setFunc(apiRef, "co", (fn) => {
      const b = runtime.bound.get(e);
      if (!b || typeof fn !== "string") return 0;
      const handle = vm.startThread(b.table, fn, b.api);
      if (handle === null) return 0;
      // The initial resume already ran to the first yield: honor it.
      runtime.coros.push({ handle, owner: e, wakeAt: runtime.time + Math.max(0, vm.yieldedNumber(handle)) });
      return handle;
    });
  }
}
