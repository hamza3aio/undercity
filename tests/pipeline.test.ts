import { describe, expect, it } from "vitest";
import { AssetDB } from "../src/assets/db.js";
import { Logger } from "../src/debug/logger.js";
import {
  ImportPipeline, defaultImporters, hashBytes, importGltf, importOBJ, parseGLB,
  type Importer, type ImportResult,
} from "../src/assets/pipeline.js";

const TRIANGLE_OBJ = `# tiny triangle
v 0 0 0
v 1 0 0
v 0 1 0
vn 0 0 1
f 1//1 2//1 3//1
`;

/** Builds a minimal GLB with one triangle. */
function makeGLB(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = new ArrayBuffer(positions.byteLength);
  new Float32Array(bin).set(positions);
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
    meshes: [{ name: "tri", primitives: [{ attributes: { POSITION: 0 } }] }],
    materials: [{ name: "red", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 0.5 } }],
  };
  const jsonText = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.byteLength % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPad;
  const binChunkLen = bin.byteLength + binPad;
  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const bytes = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunkLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  bytes.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) bytes[20 + jsonBytes.length + i] = 0x20; // spaces
  const binStart = 20 + jsonChunkLen;
  dv.setUint32(binStart, binChunkLen, true);
  dv.setUint32(binStart + 4, 0x004e4942, true); // BIN
  bytes.set(new Uint8Array(bin), binStart + 8);
  return out;
}

describe("hashBytes", () => {
  it("is stable and content sensitive", () => {
    expect(hashBytes("abc")).toBe(hashBytes("abc"));
    expect(hashBytes("abc")).not.toBe(hashBytes("abd"));
    expect(hashBytes(new Uint8Array([1, 2, 3]).buffer)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("OBJ import", () => {
  it("reads positions, normals and indices", () => {
    const r = importOBJ(TRIANGLE_OBJ, "tri");
    expect(r.meshes).toHaveLength(1);
    expect(r.meshes[0].positions).toHaveLength(9);
    expect(r.meshes[0].indices).toHaveLength(3);
    expect(r.meshes[0].name).toBe("tri");
    expect(r.warnings).toEqual([]);
  });

  it("warns about empty files and generates normals for OBJ", () => {
    const noFaces = importOBJ("v 0 0 0\nv 1 0 0\nv 0 1 0\n");
    expect(noFaces.warnings.join(" ")).toContain("no faces");
    // parseOBJ always returns a full-size normal buffer.
    const noNormals = importOBJ("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    expect(noNormals.meshes[0].normals).toHaveLength(noNormals.meshes[0].positions.length);
    expect(importOBJ("").warnings.length).toBeGreaterThan(0);
  });
});

describe("GLB container", () => {
  it("splits the JSON and binary chunks", () => {
    const { json, bin } = parseGLB(makeGLB());
    expect(json.asset.version).toBe("2.0");
    expect(bin).toBeInstanceOf(ArrayBuffer);
  });

  it("rejects non-GLB and broken files with clear errors", () => {
    expect(() => parseGLB(new ArrayBuffer(4))).toThrow(/too small/);
    const bad = new ArrayBuffer(16);
    new DataView(bad).setUint32(0, 0x12345678, true);
    expect(() => parseGLB(bad)).toThrow(/magic/);
    const wrongVersion = makeGLB();
    new DataView(wrongVersion).setUint32(4, 1, true);
    expect(() => parseGLB(wrongVersion)).toThrow(/version/);
  });
});

describe("glTF import", () => {
  it("imports geometry from a GLB", () => {
    const r = importGltf(makeGLB());
    expect(r.meshes).toHaveLength(1);
    expect(r.meshes[0].positions).toHaveLength(9);
    expect(r.meshes[0].indices).toHaveLength(3);
    expect(r.warnings.join(" ")).toContain("no NORMAL");
    expect(r.materials).toHaveLength(1);
    expect(r.materials[0].baseColor[0]).toBe(1);
    expect(r.materials[0].roughness).toBe(0.5);
  });

  it("imports a JSON glTF that needs no binary chunk", () => {
    const json = JSON.stringify({
      asset: { version: "2.0" },
      meshes: [],
      materials: [{ name: "grey", pbrMetallicRoughness: {} }],
    });
    const r = importGltf(json);
    expect(r.meshes).toHaveLength(0);
    expect(r.materials[0].name).toBe("grey");
    expect(r.materials[0].metallic).toBe(1); // glTF default
  });

  it("refuses a non-2.0 asset and reports missing binary data", () => {
    expect(() => importGltf(JSON.stringify({ asset: { version: "1.0" } }))).toThrow(/version/);
    const geo = JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "x.bin", byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    });
    expect(() => importGltf(geo)).toThrow(/binary chunk/);
  });

  it("skips primitives without positions and warns", () => {
    const json = JSON.stringify({
      asset: { version: "2.0" },
      meshes: [{ name: "empty", primitives: [{ attributes: {} }] }],
    });
    const r = importGltf(json);
    expect(r.meshes).toHaveLength(0);
    expect(r.warnings.join(" ")).toContain("no POSITION");
  });
});

describe("ImportPipeline", () => {
  function pipeline(extra: Importer[] = []) {
    const db = new AssetDB();
    const log = new Logger({ mirror: false, clock: () => 0 });
    const p = new ImportPipeline({ db, log, importers: [...defaultImporters(), ...extra] });
    return { db, log, p };
  }

  it("routes files to the right importer", () => {
    const { p } = pipeline();
    expect(p.importerFor("a.obj")?.id).toBe("obj");
    expect(p.importerFor("A.GLB")?.id).toBe("glb");
    expect(p.importerFor("image.png")).toBeNull();
  });

  it("imports, registers in the DB and reports progress", () => {
    const { db, p } = pipeline();
    const seen: string[] = [];
    (p as unknown as { onChange: (j: unknown) => void }).onChange = (j) => seen.push((j as { status: string }).status);
    const id = p.enqueue("tri.obj", TRIANGLE_OBJ);
    expect(id).not.toBeNull();
    expect(p.pending).toBe(1);
    expect(p.runAll()).toBe(1);
    expect(seen).toContain("running");
    expect(seen).toContain("done");
    expect(p.pending).toBe(0);
    const meta = db.findByPath("import:tri.obj");
    expect(meta).toBeDefined();
    expect(meta?.hash).toBe(hashBytes(TRIANGLE_OBJ));
    expect(meta?.kind).toBe("model");
    const res = p.resultOf(id!)!;
    expect(res.meshes).toHaveLength(1);
  });

  it("skips unchanged files and reimports changed ones", () => {
    const { db, log } = pipeline();
    const p1 = new ImportPipeline({ db, log, importers: defaultImporters() });
    p1.enqueue("tri.obj", TRIANGLE_OBJ);
    p1.runAll();
    const guid = db.findByPath("import:tri.obj")!.guid;
    // Same content: not queued at all.
    expect(p1.enqueue("tri.obj", TRIANGLE_OBJ)).toBeNull();
    // Changed content: reimported into the same GUID.
    const p2 = new ImportPipeline({ db, log, importers: defaultImporters() });
    const id = p2.enqueue("tri.obj", TRIANGLE_OBJ + "\nv 2 2 0\n");
    expect(id).not.toBeNull();
    p2.runAll();
    expect(db.findByPath("import:tri.obj")!.guid).toBe(guid);
    expect(db.findByPath("import:tri.obj")!.hash).toBe(hashBytes(TRIANGLE_OBJ + "\nv 2 2 0\n"));
  });

  it("reports failures without stopping the queue", () => {
    const { p, log } = pipeline();
    p.enqueue("broken.obj", "v 0 0 0\nf 1 2\n"); // malformed but parseable
    const bad = p.enqueue("bad.glb", new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer);
    p.enqueue("good.obj", TRIANGLE_OBJ);
    p.runAll();
    const jobs = p.jobs;
    expect(jobs.find((j) => j.id === bad)?.status).toBe("failed");
    expect(jobs.find((j) => j.status === "done")).toBeDefined();
    expect(log.history({ level: "error" }).length).toBeGreaterThan(0);
  });

  it("ignores files with no importer (and says so)", () => {
    const { p, log } = pipeline();
    expect(p.enqueue("texture.png", "x")).toBeNull();
    expect(log.history({ system: "import" })[0].message).toContain("no importer");
  });

  it("cancels a queued job", () => {
    const { p } = pipeline();
    const id = p.enqueue("tri.obj", TRIANGLE_OBJ)!;
    expect(p.cancel(id)).toBe(true);
    expect(p.pending).toBe(0);
    expect(p.cancel(id)).toBe(false);
  });

  it("pump processes one job at a time within its budget", () => {
    const { p } = pipeline();
    p.enqueue("a.obj", TRIANGLE_OBJ);
    p.enqueue("b.obj", TRIANGLE_OBJ);
    expect(p.pump(0)).toBeGreaterThanOrEqual(1);
    expect(p.pending).toBeLessThan(2);
  });

  it("accepts a plugin-provided importer", () => {
    const custom: Importer = {
      id: "cube",
      label: "Cube JSON",
      extensions: [".cubedef"],
      import: (): ImportResult => ({
        meshes: [{ name: "cube", positions: [], normals: [], uvs: [], indices: [] }],
        materials: [], dependencies: [], warnings: [],
      }),
    };
    const { p, db } = pipeline([custom]);
    expect(p.importerFor("thing.cubedef")?.id).toBe("cube");
    p.enqueue("thing.cubedef", "{}");
    p.runAll();
    expect(db.findByPath("import:thing.cubedef")).toBeDefined();
    expect(() => p.register(custom)).toThrow(/duplicate/);
  });

  it("wires dependencies when a result asks for them", () => {
    const db = new AssetDB();
    const baseGuid = db.register("tex/base.png", "texture");
    const dep: Importer = {
      id: "withdep", label: "With dep", extensions: [".dep"],
      import: (): ImportResult => ({
        meshes: [], materials: [], dependencies: [baseGuid], warnings: [],
      }),
    };
    const p = new ImportPipeline({ db, importers: [dep] });
    p.enqueue("a.dep", "{}");
    p.runAll();
    const meta = db.findByPath("import:a.dep")!;
    expect(meta.dependencies).toEqual([baseGuid]);
    expect(db.validate()).toEqual([]);
  });

  it("drops dependency edges that no longer exist", () => {
    const db = new AssetDB();
    let target = "";
    const dep: Importer = {
      id: "ghostdep", label: "Ghost dep", extensions: [".ghost"],
      import: (): ImportResult => ({
        meshes: [], materials: [], dependencies: [target], warnings: [],
      }),
    };
    const p = new ImportPipeline({ db, importers: [dep] });
    target = db.register("tex/temp.png", "texture");
    p.enqueue("a.ghost", "{}");
    p.runAll();
    expect(db.findByPath("import:a.ghost")!.dependencies).toEqual([target]);
    // The referenced asset goes away: the edge is dropped, not kept dangling.
    db.remove(target, true);
    p.enqueue("a.ghost", "{}v2");
    p.runAll();
    expect(db.findByPath("import:a.ghost")!.dependencies).toEqual([]);
    expect(db.validate()).toEqual([]);
  });
});
