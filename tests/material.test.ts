import { describe, expect, it } from "vitest";
import { Vec3 } from "../src/math/vec3.js";
import {
  MaterialDB, makePBR, resolveMaterial, sanitizeMaterial,
} from "../src/rendering/materials.js";
import { evalPBR } from "../src/rendering/pbr.js";

describe("MaterialDB", () => {
  it("registers, gets, lists and duplicates", () => {
    const db = new MaterialDB();
    db.register("a", makePBR("A", { metallic: 0.5 }));
    expect(db.has("a")).toBe(true);
    expect(db.get("a")!.metallic).toBe(0.5);
    expect(db.ids()).toEqual(["a"]);
    const copy = db.duplicate("a", "b");
    expect(copy.metallic).toBe(0.5);
    expect(copy).not.toBe(db.get("a"));
    copy.albedo[0] = 0; // deep copy: original untouched
    expect(db.get("a")!.albedo[0]).toBe(1);
    expect(() => db.duplicate("missing", "x")).toThrow(/unknown/);
    expect(() => db.duplicate("a", "b")).toThrow(/already exists/);
  });

  it("ships sane presets", () => {
    const db = new MaterialDB();
    db.presets();
    expect(db.get("metal")!.metallic).toBe(1);
    expect(db.get("matte")!.roughness).toBeGreaterThan(0.8);
    expect(db.get("lamp")!.emissiveIntensity).toBeGreaterThan(1);
  });

  it("sanitizes ranges and modes", () => {
    const m = sanitizeMaterial(makePBR("x", {
      metallic: 5, roughness: -2, opacity: 2, alphaCutoff: -1,
      normalScale: -3, emissiveIntensity: -1, alphaMode: "weird" as never,
    }));
    expect(m.metallic).toBe(1);
    expect(m.roughness).toBe(0);
    expect(m.opacity).toBe(1);
    expect(m.alphaCutoff).toBe(0);
    expect(m.normalScale).toBe(0);
    expect(m.emissiveIntensity).toBe(0);
    expect(m.alphaMode).toBe("opaque");
  });
});

describe("resolveMaterial", () => {
  it("routes to PBR only for registered ids", () => {
    const db = new MaterialDB();
    db.register("gold", makePBR("Gold"));
    const base = { meshId: "cube", color: [1, 1, 1] as [number, number, number] };
    expect(resolveMaterial(base, db)).toBeUndefined();
    expect(resolveMaterial({ ...base, materialId: "gold" }, db)!.name).toBe("Gold");
    expect(resolveMaterial({ ...base, materialId: "ghost" }, db)).toBeUndefined();
  });
});

describe("evalPBR reference", () => {
  const N = new Vec3(0, 1, 0);
  const V = new Vec3(0.3, 0.9, 0).normalize();
  const L = new Vec3(0, 1, 0);
  const white: [number, number, number] = [1, 1, 1];

  it("diffuse dominates rough dielectrics (minus the 4% Fresnel floor)", () => {
    const r = evalPBR([0.8, 0.8, 0.8], 0, 1, N, V, L, white);
    // kd = 1 - F0 = 0.96 at near-normal incidence
    expect(r.diffuse[0]).toBeCloseTo((0.96 * 0.8) / Math.PI, 3);
    expect(r.specular[0]).toBeLessThan(0.02);
  });

  it("metals carry ~zero diffuse", () => {
    const r = evalPBR([1, 1, 1], 1, 0.3, N, V, L, white);
    expect(r.diffuse[0]).toBeLessThan(1e-3);
    expect(r.specular[0]).toBeGreaterThan(0);
  });

  it("backlit surfaces get nothing", () => {
    const r = evalPBR([1, 1, 1], 0, 0.5, N, V, new Vec3(0, -1, 0), white);
    expect(r.diffuse).toEqual([0, 0, 0]);
    expect(r.specular).toEqual([0, 0, 0]);
  });

  it("smooth mirrors spike far above rough response", () => {
    const aligned = new Vec3(0, 1, 0);
    const smooth = evalPBR([1, 1, 1], 0, 0.05, N, aligned, L, white);
    const rough = evalPBR([1, 1, 1], 0, 1, N, aligned, L, white);
    expect(smooth.specular[0] / Math.max(rough.specular[0], 1e-6)).toBeGreaterThan(50);
  });

  it("stays finite at roughness 0 and conserves energy on white", () => {
    const r = evalPBR([1, 1, 1], 0, 0, N, V, L, white);
    for (const v of [...r.diffuse, ...r.specular]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    const total = r.diffuse[0] + r.specular[0];
    expect(total).toBeLessThan(1.05);
  });
});
