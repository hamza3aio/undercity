// Minimal ambient types for the fengari API surface this engine uses.
// Full fengari typings don't ship with the package; keep this list exact.

declare module "fengari" {
  export type LuaState = unknown;
  export type Luastring = Uint8Array;
  export function to_luastring(s: string): Luastring;
  export function to_jsstring(s: Luastring | null | undefined): string;
  export namespace lua {
    const LUA_OK: number;
    const LUA_YIELD: number;
    const LUA_ERRRUN: number;
    const LUA_ERRSYNTAX: number;
    const LUA_ERRMEM: number;
    const LUA_ERRERR: number;
    const LUA_REGISTRYINDEX: number;
    const LUA_TNIL: number;
    const LUA_TNUMBER: number;
    const LUA_TBOOLEAN: number;
    const LUA_TSTRING: number;
    const LUA_TTABLE: number;
    const LUA_TFUNCTION: number;
    function lua_gettop(L: LuaState): number;
    function lua_settop(L: LuaState, n: number): void;
    function lua_pushnil(L: LuaState): void;
    function lua_pushnumber(L: LuaState, n: number): void;
    function lua_pushboolean(L: LuaState, b: boolean): void;
    function lua_pushstring(L: LuaState, s: Luastring): void;
    function lua_pushjsfunction(L: LuaState, fn: (L: LuaState) => number): void;
    function lua_pushvalue(L: LuaState, idx: number): void;
    function lua_newtable(L: LuaState): void;
    function lua_getfield(L: LuaState, idx: number, key: Luastring): number;
    function lua_setfield(L: LuaState, idx: number, key: Luastring): void;
    function lua_getglobal(L: LuaState, key: Luastring): number;
    function lua_setglobal(L: LuaState, key: Luastring): void;
    function lua_type(L: LuaState, idx: number): number;
    function lua_tonumber(L: LuaState, idx: number): number;
    function lua_toboolean(L: LuaState, idx: number): boolean;
    function lua_tostring(L: LuaState, idx: number): Luastring | null;
    function lua_rawgeti(L: LuaState, idx: number, n: number): number;
    function lua_next(L: LuaState, idx: number): number;
    function lua_remove(L: LuaState, idx: number): void;
    function lua_pcall(L: LuaState, nargs: number, nresults: number, errfunc: number): number;
    function lua_newthread(L: LuaState): LuaState;
    function lua_resume(L: LuaState, from: LuaState | null, nargs: number): number;
    function lua_status(L: LuaState): number;
    function lua_yield(L: LuaState, nresults: number): number;
  }
  export namespace lauxlib {
    const LUA_NOREF: number;
    function luaL_newstate(): LuaState;
    function luaL_openlibs(L: LuaState): void;
    function luaL_loadstring(L: LuaState, s: Luastring): number;
    function luaL_ref(L: LuaState, t: number): number;
    function luaL_unref(L: LuaState, t: number, ref: number): void;
  }
  export namespace lualib {
    function luaL_openlibs(L: LuaState): void;
  }
}
