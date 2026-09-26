// Glitch Lua VM — sandboxed fengari wrapper. Pure logic + real interpreter:
// runs headless in vitest AND bundled in browsers (no WASM/fetch needed).
// Sandboxing: io/os-require/loaders are removed; scripts get math, string,
// table, coroutine, utf8, a captured print(), and the engine API table.

import { lua, lauxlib, lualib, to_luastring, to_jsstring, type LuaState } from "fengari";

export type LuaScalar = number | string | boolean;

const SANDBOXED_GLOBALS = [
  "dofile", "loadfile", "load", "loadstring", "require", "package",
  "io", "os", "debug", "newproxy", "collectgarbage",
];

const PRELUDE = `
function waitSeconds(s)
  assert(type(s) == "number" and s >= 0, "waitSeconds needs seconds >= 0")
  return coroutine.yield(s or 0)
end
`;

export class LuaVM {
  private L: LuaState;
  logs: string[] = [];

  constructor() {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    // Sandbox: drop loaders, IO, OS and debug facilities.
    for (const name of SANDBOXED_GLOBALS) {
      lua.lua_pushnil(this.L);
      lua.lua_setglobal(this.L, to_luastring(name));
    }
    // Captured print().
    const logs = this.logs;
    lua.lua_pushjsfunction(this.L, (L) => {
      const n = lua.lua_gettop(L);
      const parts: string[] = [];
      for (let i = 1; i <= n; i++) {
        const t = lua.lua_type(L, i);
        if (t === lua.LUA_TSTRING) parts.push(to_jsstring(lua.lua_tostring(L, i)));
        else if (t === lua.LUA_TNUMBER) parts.push(String(lua.lua_tonumber(L, i)));
        else if (t === lua.LUA_TBOOLEAN) parts.push(lua.lua_toboolean(L, i) ? "true" : "false");
        else if (t === lua.LUA_TNIL) parts.push("nil");
        else parts.push(`<${lua.lua_type(L, i)}>`);
      }
      logs.push(parts.join("\t"));
      if (logs.length > 200) logs.shift();
      return 0;
    });
    lua.lua_setglobal(this.L, to_luastring("print"));
    // waitSeconds() prelude for coroutines.
    if (lauxlib.luaL_loadstring(this.L, to_luastring(PRELUDE)) !== lua.LUA_OK) {
      throw new Error("LuaVM: prelude failed to compile");
    }
    if (lua.lua_pcall(this.L, 0, 0, 0) !== lua.LUA_OK) {
      throw new Error("LuaVM: prelude failed to run");
    }
  }

  // Load a chunk that must RETURN a table (the script's exports).
  load(source: string, chunkname = "script"): { ok: boolean; ref?: number; error?: string } {
    const L = this.L;
    if (lauxlib.luaL_loadstring(L, to_luastring(source)) !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, 0);
      return { ok: false, error: msg };
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, 0);
      return { ok: false, error: msg };
    }
    if (lua.lua_type(L, -1) !== lua.LUA_TTABLE) {
      lua.lua_settop(L, 0);
      return { ok: false, error: `chunk must return a table (got ${lua.lua_type(L, -1)})` };
    }
    const ref = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
    return { ok: true, ref };
  }

  unref(ref: number): void {
    lauxlib.luaL_unref(this.L, lua.LUA_REGISTRYINDEX, ref);
  }

  // Call table[fn](api, ...extra). Missing hooks are not errors.
  callMethodArgs(
    ref: number, fn: string, apiRef: number, extra: LuaScalar[]
  ): { ok: boolean; error?: string } {
    const L = this.L;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    lua.lua_getfield(L, -1, to_luastring(fn));
    if (lua.lua_type(L, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_settop(L, 0);
      return { ok: true };
    }
    lua.lua_remove(L, -2); // drop table, leave fn
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, apiRef);
    for (const v of extra) {
      if (typeof v === "number") lua.lua_pushnumber(L, v);
      else if (typeof v === "string") lua.lua_pushstring(L, to_luastring(v));
      else lua.lua_pushboolean(L, v);
    }
    const st = lua.lua_pcall(L, 1 + extra.length, 0, 0);
    if (st !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_settop(L, 0);
      return { ok: false, error: msg };
    }
    lua.lua_settop(L, 0);
    return { ok: true };
  }

  newTable(): number {
    lua.lua_newtable(this.L);
    return lauxlib.luaL_ref(this.L, lua.LUA_REGISTRYINDEX);
  }

  setField(ref: number, key: string, v: LuaScalar): void {
    const L = this.L;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    if (typeof v === "number") lua.lua_pushnumber(L, v);
    else if (typeof v === "string") lua.lua_pushstring(L, to_luastring(v));
    else lua.lua_pushboolean(L, v);
    lua.lua_setfield(L, -2, to_luastring(key));
    lua.lua_settop(L, 0);
  }

  // Bind a JS callback under key. Arguments arrive marshaled as LuaScalar
  // (non-scalars become 0 — documented); return a scalar or void.
  setFunc(ref: number, key: string, fn: (...args: LuaScalar[]) => LuaScalar | void): void {
    const L = this.L;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    lua.lua_pushjsfunction(L, (LL) => {
      const n = lua.lua_gettop(LL);
      const args: LuaScalar[] = [];
      for (let i = 1; i <= n; i++) {
        const t = lua.lua_type(LL, i);
        if (t === lua.LUA_TNUMBER) args.push(lua.lua_tonumber(LL, i));
        else if (t === lua.LUA_TSTRING) args.push(to_jsstring(lua.lua_tostring(LL, i)));
        else if (t === lua.LUA_TBOOLEAN) args.push(lua.lua_toboolean(LL, i));
        else args.push(0);
      }
      const out = fn(...args);
      if (typeof out === "number") lua.lua_pushnumber(LL, out);
      else if (typeof out === "string") lua.lua_pushstring(LL, to_luastring(out));
      else if (typeof out === "boolean") lua.lua_pushboolean(LL, out);
      else return 0;
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring(key));
    lua.lua_settop(L, 0);
  }

  getScalar(ref: number, key: string): LuaScalar | undefined {
    const L = this.L;
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    lua.lua_getfield(L, -1, to_luastring(key));
    const t = lua.lua_type(L, -1);
    let out: LuaScalar | undefined;
    if (t === lua.LUA_TNUMBER) out = lua.lua_tonumber(L, -1);
    else if (t === lua.LUA_TSTRING) out = to_jsstring(lua.lua_tostring(L, -1));
    else if (t === lua.LUA_TBOOLEAN) out = lua.lua_toboolean(L, -1);
    lua.lua_settop(L, 0);
    return out;
  }

  // Scalar fields only (numbers/strings/booleans) — functions/tables skipped.
  // Used for inspector-style editable variables.
  readVars(ref: number): Record<string, LuaScalar> {
    const L = this.L;
    const out: Record<string, LuaScalar> = {};
    lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
    lua.lua_pushnil(L);
    while (lua.lua_next(L, -2) !== 0) {
      // stack: table, key, value
      if (lua.lua_type(L, -2) === lua.LUA_TSTRING) {
        const key = to_jsstring(lua.lua_tostring(L, -2));
        const t = lua.lua_type(L, -1);
        if (t === lua.LUA_TNUMBER) out[key] = lua.lua_tonumber(L, -1);
        else if (t === lua.LUA_TSTRING) out[key] = to_jsstring(lua.lua_tostring(L, -1));
        else if (t === lua.LUA_TBOOLEAN) out[key] = lua.lua_toboolean(L, -1);
      }
      lua.lua_settop(L, -2); // pop value, keep key
    }
    lua.lua_settop(L, 0);
    return out;
  }

  private threads = new Map<number, LuaState>();
  private nextThread = 1;

  // Start table[fn](api) as a coroutine. Returns a thread handle, or null
  // when the hook is missing/not a function.
  startThread(tableRef: number, fn: string, apiRef: number): number | null {
    const L = this.L;
    const co = lua.lua_newthread(L); // pushes thread object on L
    lua.lua_rawgeti(co, lua.LUA_REGISTRYINDEX, tableRef);
    lua.lua_getfield(co, -1, to_luastring(fn));
    if (lua.lua_type(co, -1) !== lua.LUA_TFUNCTION) {
      lua.lua_settop(L, 0); // drop thread object
      return null;
    }
    lua.lua_remove(co, -2); // drop table, leave fn
    lua.lua_rawgeti(co, lua.LUA_REGISTRYINDEX, apiRef);
    const st = lua.lua_resume(co, L, 1);
    if (st !== lua.LUA_OK && st !== lua.LUA_YIELD) {
      this.lastResumeError = to_jsstring(lua.lua_tostring(co, -1));
      lua.lua_settop(co, 0);
      lua.lua_settop(L, 0);
      return null;
    }
    const handle = this.nextThread++;
    this.threads.set(handle, co);
    lua.lua_settop(L, 0);
    if (st === lua.LUA_OK) {
      this.threads.delete(handle); // finished immediately
      return null;
    }
    return handle;
  }

  lastResumeError: string | null = null;

  // Resume a suspended coroutine. Returns "dead" when finished.
  resumeThread(handle: number, arg = 0): "suspended" | "dead" {
    const co = this.threads.get(handle);
    if (!co) return "dead";
    lua.lua_pushnumber(co, arg);
    const st = lua.lua_resume(co, this.L, 1);
    if (st === lua.LUA_YIELD) return "suspended";
    if (st !== lua.LUA_OK) {
      this.lastResumeError = to_jsstring(lua.lua_tostring(co, -1));
      lua.lua_settop(co, 0);
    }
    this.threads.delete(handle);
    return "dead";
  }

  // Seconds yielded by the last yield (top of the coroutine stack).
  yieldedNumber(handle: number): number {
    const co = this.threads.get(handle);
    if (!co) return 0;
    const v = lua.lua_tonumber(co, -1);
    lua.lua_settop(co, 0);
    return Number.isFinite(v) ? v : 0;
  }

  dropThread(handle: number): void {
    this.threads.delete(handle);
  }
}
