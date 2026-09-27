import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import {
  HOST_NET_ID, LoopbackTransport, NetClient, NetIdMap, NetServer, Predictor, PROTOCOL_VERSION,
  SnapshotBuffer, lerpTransform, quantize, selectInterest, type NetMessage,
} from "../src/net/netcore.js";

function box(world: World, x = 0, y = 0, z = 0, meshId = "cube"): number {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  world.add(e, "mesh", { meshId, color: [1, 0, 0] });
  return e;
}

describe("NetIdMap", () => {
  it("allocates stable ids and reverses them", () => {
    const w = new World();
    const e = box(w);
    const ids = new NetIdMap();
    const id = ids.add(e);
    expect(id).toBe(1); // 0 is reserved for the host
    expect(ids.add(e)).toBe(id);
    expect(ids.entityOf(id)).toBe(e);
    expect(ids.idOf(e)).toBe(id);
    expect(ids.remove(e)).toBe(id);
    expect(ids.entityOf(id)).toBeNull();
    expect(ids.remove(e)).toBeNull();
    ids.clear();
    expect(ids.size).toBe(0);
  });
});

describe("quantize and interpolation", () => {
  it("quantizes to a stable grid and keeps scale exact", () => {
    const q = quantize({ x: 1.234, y: 0, z: -2.345, ry: 0.1, sx: 1, sy: 1, sz: 1 });
    expect(q.x).toBeCloseTo(1.23, 5);
    expect(q.z).toBeCloseTo(-2.35, 5);
    expect(q.sx).toBe(1);
    expect(quantize({ x: 1.234, y: 0, z: -2.345, ry: 0.1, sx: 1, sy: 1, sz: 1 })).toEqual(q);
  });

  it("lerps and clamps", () => {
    const a = { x: 0, y: 0, z: 0, ry: 0, sx: 1, sy: 1, sz: 1 };
    const b = { ...a, x: 10, ry: 2 };
    expect(lerpTransform(a, b, 0.5).x).toBe(5);
    expect(lerpTransform(a, b, -1).x).toBe(0);
    expect(lerpTransform(a, b, 9).x).toBe(10);
  });
});

describe("SnapshotBuffer", () => {
  const tr = (x: number) => ({ x, y: 0, z: 0, ry: 0, sx: 1, sy: 1, sz: 1 });

  it("holds the oldest snapshot while the buffer is still filling", () => {
    const b = new SnapshotBuffer();
    b.delayMs = 100;
    b.push({ net: 1, tr: tr(0), t: 1000 });
    expect(b.sample(1, 1000)!.x).toBe(0);
  });

  it("interpolates between bracketing snapshots", () => {
    const b = new SnapshotBuffer();
    b.delayMs = 100;
    b.push({ net: 1, tr: tr(0), t: 1000 });
    b.push({ net: 1, tr: tr(100), t: 1100 });
    expect(b.sample(1, 1100)!.x).toBe(0); // target 1000
    expect(b.sample(1, 1150)!.x).toBe(50); // target 1050
    expect(b.sample(1, 1200)!.x).toBe(100); // target 1100
  });

  it("clamps past the newest snapshot and reports latency", () => {
    const b = new SnapshotBuffer();
    b.delayMs = 100;
    b.push({ net: 1, tr: tr(5), t: 1000 });
    expect(b.sample(1, 5000)!.x).toBe(5);
    expect(b.latencyMs(1, 5000)).toBeCloseTo(5000 - 100 - 1000);
    expect(b.latencyMs(1, 1050)).toBe(0);
  });

  it("drops out-of-order packets", () => {
    const b = new SnapshotBuffer();
    b.push({ net: 1, tr: tr(1), t: 2000 });
    b.push({ net: 1, tr: tr(9), t: 1000 });
    expect(b.sample(1, 2100)!.x).toBe(1);
  });

  it("bounds per-entity history and forgets entities", () => {
    const b = new SnapshotBuffer();
    b.maxPerEntity = 3;
    for (let i = 0; i < 10; i++) b.push({ net: 1, tr: tr(i), t: 1000 + i });
    b.push({ net: 2, tr: tr(0), t: 1000 });
    expect(b.tracked).toBe(2);
    b.forget(1);
    expect(b.tracked).toBe(1);
    expect(b.sample(1, 99999)).toBeNull();
  });
});

describe("interest management", () => {
  it("picks the nearest N deterministically", () => {
    const c = [{ id: 1, x: 10, z: 0 }, { id: 2, x: 1, z: 0 }, { id: 3, x: 5, z: 0 }];
    expect(selectInterest(c, 0, 0, 2)).toEqual([2, 3]);
    expect(selectInterest(c, 0, 0, 0)).toEqual([]);
    expect(selectInterest(c, 0, 0, 10)).toEqual([2, 3, 1]);
  });
});

describe("LoopbackTransport", () => {
  it("keeps the two directions apart and reports peers", () => {
    const loop = new LoopbackTransport();
    const toServer: NetMessage[] = [];
    const toClient: NetMessage[] = [];
    const peerEvents: string[] = [];
    loop.on({ onMessage: (m) => toServer.push(m), onPeerJoin: (p) => peerEvents.push(`s+${p}`), onPeerLeave: (p) => peerEvents.push(`s-${p}`) });
    loop.attachClient({ onMessage: (m) => toClient.push(m), onPeerJoin: (p) => peerEvents.push(`c+${p}`), onPeerLeave: (p) => peerEvents.push(`c-${p}`) });
    loop.clientSend({ t: "hello", peer: 1, protocol: PROTOCOL_VERSION });
    loop.broadcast({ t: "despawn", net: 3 });
    expect(toServer).toHaveLength(1);
    expect(toClient).toHaveLength(1);
    loop.join(7);
    expect(peerEvents).toEqual(["s+7", "c+7"]);
    loop.leave(7);
    expect(loop.peerIds()).toEqual([]);
    loop.close();
  });
});

describe("server + client replication", () => {
  function link(maxInterest = 32) {
    // One loopback link hosting both ends: the transport keeps the two
    // directions apart, exactly like a real socket pair.
    const loop = new LoopbackTransport();
    const s = new NetServer({ transport: loop, maxInterest });
    const local = new World();
    const c = new NetClient(loop, local);
    loop.join(1);
    return { loop, s, c, local };
  }

  it("spawns, syncs, interpolates and despawns", () => {
    const world = new World();
    const { s, c, local } = link();
    c.buffer.delayMs = 0;
    c.connect();
    expect(s.peerCount).toBe(1);

    const e = box(world, 5, 0, 5);
    const net = s.spawn(e, world);
    expect(net).toBe(1);
    expect(c.replicaCount).toBe(1);
    const replica = c.entityFor(1)!;
    expect(local.get<{ position: Vec3 }>(replica, "transform")!.position.x).toBe(5);
    expect(local.get<{ meshId: string }>(replica, "mesh")!.meshId).toBe("cube");

    world.get<{ position: Vec3 }>(e, "transform")!.position.set(15, 0, 5);
    expect(s.sync(e, world)).toBe(true);
    world.get<{ position: Vec3 }>(e, "transform")!.position.set(25, 0, 5);
    s.sync(e, world);
    expect(c.renderReplicas()).toBe(1);
    expect(local.get<{ position: Vec3 }>(replica, "transform")!.position.x).toBeGreaterThanOrEqual(15);

    expect(s.despawn(e)).toBe(true);
    expect(c.replicaCount).toBe(0);
    expect(local.isAlive(replica)).toBe(false);
  });

  it("ignores a second spawn for the same net id", () => {
    const world = new World();
    const { s, c } = link();
    const e = box(world);
    s.spawn(e, world);
    const first = c.entityFor(1)!;
    s.spawn(e, world); // same entity -> same id
    expect(c.replicaCount).toBe(1);
    expect(c.entityFor(1)).toBe(first);
  });

  it("disposes replicas cleanly", () => {
    const world = new World();
    const { s, c, local } = link();
    s.spawn(box(world), world);
    expect(c.replicaCount).toBe(1);
    c.dispose();
    expect(c.replicaCount).toBe(0);
    expect(local.query("mesh")).toHaveLength(0);
  });

  it("executes RPCs on the host and isolates a throwing handler", () => {
    const { s, c } = link();
    let got: unknown = null;
    s.rpc("chat", (args) => { got = args; });
    s.rpc("boom", () => { throw new Error("bad handler"); });
    c.sendRpc("chat", { text: "hi" });
    expect(got).toEqual({ text: "hi" });
    expect(() => c.sendRpc("boom")).not.toThrow();
    expect(() => c.sendRpc("unknown")).not.toThrow();
  });

  it("client handlers receive host RPCs", () => {
    const { s, c } = link();
    let seen = "";
    c.handlers.set("notice", (a) => { seen = (a as { text: string }).text; });
    s.call("all", "notice", { text: "server said hi" });
    expect(seen).toBe("server said hi");
  });

  it("interest limits what a peer is told about", () => {
    const { s } = link(1);
    const world = new World();
    for (let i = 0; i < 3; i++) s.spawn(box(world, i * 20, 0, 0), world);
    s.updateInterest(world, () => new Vec3(0, 0, 0));
    const seen = (s as unknown as { interest: Map<number, number[]> }).interest.get(1);
    expect(seen).toHaveLength(1);
  });

  it("ignores a protocol mismatch and never loops on hello", () => {
    const loop = new LoopbackTransport();
    const s = new NetServer({ transport: loop });
    void new NetClient(loop, new World());
    let handled = false;
    s.rpc("x", () => { handled = true; });
    loop.clientSend({ t: "hello", peer: 1, protocol: 999 });
    expect(handled).toBe(false);
    expect(() => loop.clientSend({ t: "hello", peer: 1, protocol: PROTOCOL_VERSION })).not.toThrow();
    expect(handled).toBe(false);
  });

  it("uses net id 0 for the host", () => {
    expect(HOST_NET_ID).toBe(0);
  });
});

describe("client-side prediction", () => {
  const start = () => ({ x: 0, y: 0, z: 0, ry: 0, sx: 1, sy: 1, sz: 1 });

  it("applies input immediately and remembers it", () => {
    const p = new Predictor();
    const a = p.apply(start(), 1, 0, 0.1, 1);
    expect(a.x).toBeCloseTo(0.6);
    expect(a.ry).toBeCloseTo(Math.PI / 2);
    expect(p.pending).toBe(1);
  });

  it("reconciles against the server and replays unacked input", () => {
    const p = new Predictor();
    let tr = p.apply(start(), 1, 0, 0.1, 1);
    tr = p.apply(tr, 1, 0, 0.1, 2);
    // The server acknowledges input 1 and is slightly behind (0.5 vs 0.6).
    // Input 2 is re-applied on top of the corrected state.
    const fixed = p.reconcile({ ...tr, x: 0.5 }, 1);
    expect(fixed.x).toBeCloseTo(0.5 + 0.6);
    expect(p.pending).toBe(1);
  });

  it("replays several unacked inputs in order", () => {
    const p = new Predictor();
    let tr = p.apply(start(), 1, 0, 0.1, 1);
    tr = p.apply(tr, 1, 0, 0.1, 2);
    tr = p.apply(tr, 0, 1, 0.1, 3);
    const fixed = p.reconcile(start(), 0);
    expect(fixed.x).toBeCloseTo(tr.x, 5);
    expect(fixed.z).toBeCloseTo(tr.z, 5);
  });

  it("clears history when everything is acknowledged", () => {
    const p = new Predictor();
    const tr = p.apply(start(), 1, 0, 0.1, 1);
    p.reconcile(tr, 1);
    expect(p.pending).toBe(0);
    p.reset();
    expect(p.pending).toBe(0);
    expect(p.lastAcked).toBe(0);
  });

  it("bounds history and ignores zero input", () => {
    const p = new Predictor();
    p.maxHistory = 3;
    let tr = start();
    for (let i = 1; i <= 6; i++) tr = p.apply(tr, 1, 0, 0.1, i);
    expect(p.pending).toBe(3);
    const still = p.apply(tr, 0, 0, 0.1, 7);
    expect(still.x).toBeCloseTo(tr.x);
    expect(still.ry).toBeCloseTo(tr.ry);
  });
});
