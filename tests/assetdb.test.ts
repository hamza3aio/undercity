import { describe, expect, it } from "vitest";
import {
  ASSET_DB_VERSION, AssetDB, defaultSettings, isGuid, makeGuid, sanitizeSettings,
} from "../src/assets/db.js";

describe("makeGuid / isGuid", () => {
  it("emits valid GUID-shaped ids", () => {
    expect(isGuid(makeGuid())).toBe(true);
    expect(isGuid(makeGuid("stable-seed"))).toBe(true);
    expect(isGuid("nope")).toBe(false);
    expect(isGuid(42)).toBe(false);
  });

  it("is stable for seeds and unique without", () => {
    expect(makeGuid("s")).toBe(makeGuid("s"));
    expect(makeGuid("a")).not.toBe(makeGuid("b"));
    expect(makeGuid()).not.toBe(makeGuid());
  });
});

describe("sanitizeSettings", () => {
  it("fills texture/model/audio defaults", () => {
    expect(defaultSettings("texture")).toMatchObject({ srgb: true, wrap: "repeat", filter: "linear" });
    expect(sanitizeSettings("model", {})).toEqual({ scale: 1, flipY: false });
    expect(sanitizeSettings("scene", { anything: 1 })).toEqual({});
  });

  it("rejects bad enums and ranges", () => {
    expect(() => sanitizeSettings("texture", { wrap: "mirror" })).toThrow();
    expect(() => sanitizeSettings("texture", { maxSize: 0 })).toThrow();
    expect(() => sanitizeSettings("model", { scale: -2 })).toThrow();
    expect(() => sanitizeSettings("audio", { volume: 2 })).toThrow();
    expect(() => sanitizeSettings("texture", null)).toThrow();
  });
});

describe("AssetDB registry", () => {
  it("registers and looks up by guid and path", () => {
    const db = new AssetDB();
    const g = db.register("tex/grass.png", "texture");
    expect(db.count).toBe(1);
    expect(db.get(g)?.path).toBe("tex/grass.png");
    expect(db.findByPath("tex/grass.png")?.guid).toBe(g);
    expect(db.get(g)?.hash).toBeNull();
  });

  it("rejects duplicates, bad kinds, and bad guids", () => {
    const db = new AssetDB();
    db.register("a.png", "texture");
    expect(() => db.register("a.png", "texture")).toThrow();
    expect(() => db.register("b.png", "nope" as never)).toThrow();
    expect(() => db.register("", "texture")).toThrow();
    expect(() => db.register("c.png", "texture", { guid: "bad" })).toThrow();
    const g = makeGuid("fixed");
    db.register("d.png", "model", { guid: g });
    expect(() => db.register("e.png", "model", { guid: g })).toThrow();
  });

  it("rejects missing and self dependencies at registration", () => {
    const db = new AssetDB();
    const g = db.register("base.mat", "material");
    expect(() => db.register("x.obj", "model", { dependencies: ["missing-guid"] })).toThrow();
    const self = makeGuid("self");
    expect(() => db.register("s.obj", "model", { guid: self, dependencies: [self] })).toThrow();
    const child = db.register("wall.obj", "model", { dependencies: [g] });
    expect(db.get(child)?.dependencies).toEqual([g]);
  });

  it("rejects dependency cycles", () => {
    const db = new AssetDB();
    const a = db.register("a.mat", "material");
    const b = db.register("b.mat", "material", { dependencies: [a] });
    expect(() => db.setDependencies(a, [b])).toThrow(); // would close a->b->a
    expect(db.get(a)?.dependencies).toEqual([]); // rolled back
    expect(() => db.setDependencies("missing", [])).toThrow();
  });

  it("tracks dependents and orphans", () => {
    const db = new AssetDB();
    const mat = db.register("brick.mat", "material");
    const wall = db.register("wall.obj", "model", { dependencies: [mat] });
    db.register("song.wav", "audio");
    expect(db.dependentsOf(mat).map((a) => a.guid)).toEqual([wall]);
    expect(db.dependentsOf(wall)).toEqual([]);
    expect(new Set(db.orphans().map((a) => a.path))).toEqual(new Set(["wall.obj", "song.wav"]));
  });

  it("remove is blocked by dependents unless forced", () => {
    const db = new AssetDB();
    const mat = db.register("m.mat", "material");
    db.register("w.obj", "model", { dependencies: [mat] });
    expect(db.remove(mat)).toBe(false);
    expect(db.remove(mat, true)).toBe(true);
    expect(db.findByPath("w.obj")?.dependencies).toEqual([]);
    expect(db.remove("missing")).toBe(false);
  });

  it("touch records hash and import time", () => {
    const db = new AssetDB();
    const g = db.register("a.png", "texture");
    expect(db.touch("missing")).toBe(false);
    expect(db.touch(g, "abc123")).toBe(true);
    expect(db.get(g)?.hash).toBe("abc123");
    expect(db.get(g)?.importedAt).toBeGreaterThan(0);
  });

  it("validate() is clean for healthy graphs", () => {
    const db = new AssetDB();
    const m = db.register("m.mat", "material");
    db.register("w.obj", "model", { dependencies: [m] });
    expect(db.validate()).toEqual([]);
  });
});

describe("AssetDB persistence", () => {
  it("round-trips JSON including dependencies", () => {
    const db = new AssetDB();
    const mat = db.register("brick.mat", "material");
    const wall = db.register("wall.obj", "model", {
      settings: { scale: 2 }, dependencies: [mat],
    });
    db.touch(wall, "deadbeef");
    const back = AssetDB.fromJSON(JSON.parse(JSON.stringify(db.toJSON())));
    expect(back.count).toBe(2);
    expect(back.get(wall)?.dependencies).toEqual([mat]);
    expect(back.get(wall)?.settings).toMatchObject({ scale: 2 });
    expect(back.get(wall)?.hash).toBe("deadbeef");
    expect(back.validate()).toEqual([]);
  });

  it("loads order-independently and versionless payloads", () => {
    const db = new AssetDB();
    const mat = db.register("m.mat", "material");
    db.register("w.obj", "model", { dependencies: [mat] });
    const json = db.toJSON();
    const reversed = { version: 1, assets: [...json.assets].reverse() };
    expect(AssetDB.fromJSON(reversed).count).toBe(2);
    const noVersion = { assets: json.assets };
    expect(AssetDB.fromJSON(noVersion).count).toBe(2);
  });

  it("rejects corrupt payloads", () => {
    expect(() => AssetDB.fromJSON(null)).toThrow();
    expect(() => AssetDB.fromJSON({ version: 1 })).toThrow();
    expect(() => AssetDB.fromJSON({ version: 999, assets: [] })).toThrow();
    expect(() => AssetDB.fromJSON({ version: 1, assets: [{ kind: "texture" }] })).toThrow();
    expect(() => AssetDB.fromJSON({ version: ASSET_DB_VERSION, assets: [{ guid: makeGuid(), kind: "zzz", path: "x" }] })).toThrow();
    expect(() => AssetDB.fromJSON({
      version: 1,
      assets: [
        { guid: makeGuid("a"), kind: "material", path: "a" },
        { guid: makeGuid("b"), kind: "model", path: "b", dependencies: ["nope"] },
      ],
    })).toThrow();
  });
});
