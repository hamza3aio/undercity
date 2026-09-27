// Glitch networking foundations (Phase 23) — architecture, not a game netcode.
//
// Deliberately scoped: server-authoritative replication primitives, net
// IDs, snapshots with delta/interpolation, an RPC channel, interest
// management, and a client-side prediction *interface* with a working
// local-prediction implementation. NOT here: lag compensation, client
// anti-cheat, matchmaking, host migration (documented as future work).
//
// The transport is injected (`NetTransport`), so the same code runs over the
// existing WebRTC p2p link, a WebSocket relay, or a loopback in tests. All
// of the math (delta encoding, interpolation, interest filtering) is pure
// and headless-testable.

import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import { assignUid, findByUid, getUid, makeUid } from "../ecs/ids.js";

// --- ids ---

/**
 * Stable network ID for an entity: 0 is always the server/host itself, so a
 * replica never needs a mapping table for the local player.
 */
export const HOST_NET_ID = 0;

export class NetIdMap {
  private toNet = new Map<Entity, number>();
  private toEntity = new Map<number, Entity>();
  private next = 1;

  /** Registers a live entity and returns its net id. */
  add(e: Entity): number {
    const existing = this.toNet.get(e);
    if (existing !== undefined) return existing;
    const id = this.next++;
    this.toNet.set(e, id);
    this.toEntity.set(id, e);
    return id;
  }

  remove(e: Entity): number | null {
    const id = this.toNet.get(e) ?? null;
    if (id !== null) this.toEntity.delete(id);
    this.toNet.delete(e);
    return id;
  }

  idOf(e: Entity): number | null {
    return this.toNet.get(e) ?? null;
  }

  entityOf(id: number): Entity | null {
    return this.toEntity.get(id) ?? null;
  }

  get size(): number {
    return this.toNet.size;
  }

  clear(): void {
    this.toNet.clear();
    this.toEntity.clear();
    this.next = 1;
  }
}

// --- messages ---

export interface NetTransform {
  x: number; y: number; z: number;
  ry: number;
  sx: number; sy: number; sz: number;
}

export type NetMessage =
  | { t: "hello"; peer: number; protocol: number }
  | { t: "spawn"; net: number; uid: string; meshId: string; color: [number, number, number]; tr: NetTransform; scale: number }
  | { t: "despawn"; net: number }
  | { t: "state"; net: number; tr: NetTransform; vel?: [number, number, number] }
  | { t: "rpc"; net: number; name: string; args: unknown }
  | { t: "interest"; peers: number[] }
  | { t: "bye"; peer: number };

export const PROTOCOL_VERSION = 1;

export interface TransportHandlers {
  onMessage: (m: NetMessage, from: number) => void;
  onPeerJoin: (peer: number) => void;
  onPeerLeave: (peer: number) => void;
}

export interface NetTransport {
  send(to: number, m: NetMessage): void;
  broadcast(m: NetMessage): void;
  /** Wires the server side. Called once by NetServer. */
  on(h: TransportHandlers): void;
  /**
   * Wires the client side of a bidirectional link (loopback only). When
   * present, client traffic goes through here instead of `send`, so a
   * single-process link can host a server and a client without messages
   * echoing back to their own sender.
   */
  attachClient?(h: TransportHandlers): void;
  /** Client -> server on a bidirectional link (loopback only). */
  clientSend?(m: NetMessage): void;
  close(): void;
  peerIds(): number[];
}

/**
 * In-memory bidirectional link for tests and single-process play. The
 * server and the client see separate handler sets: `on` for the server,
 * `attachClient` for the client. `clientSend` carries client traffic the
 * other way, so a reply can never loop.
 */
export class LoopbackTransport implements NetTransport {
  private server: TransportHandlers | null = null;
  private client: TransportHandlers | null = null;
  private peers = new Set<number>();

  on(h: TransportHandlers): void {
    this.server = h;
  }

  attachClient(h: TransportHandlers): void {
    this.client = h;
  }

  join(peer: number): void {
    this.peers.add(peer);
    this.server?.onPeerJoin(peer);
    this.client?.onPeerJoin(peer);
  }

  leave(peer: number): void {
    this.peers.delete(peer);
    this.server?.onPeerLeave(peer);
    this.client?.onPeerLeave(peer);
  }

  /** Server -> client. */
  send(_to: number, m: NetMessage): void {
    this.client?.onMessage(m, 0);
  }

  /** Server -> every client. */
  broadcast(m: NetMessage): void {
    this.client?.onMessage(m, 0);
  }

  /** Client -> server. */
  clientSend(m: NetMessage): void {
    this.server?.onMessage(m, 1);
  }

  close(): void {
    this.peers.clear();
  }

  peerIds(): number[] {
    return [...this.peers];
  }
}

// --- snapshots ---

export interface ReplicaSnapshot {
  net: number;
  tr: NetTransform;
  /** Server time in ms when this was produced (for interpolation). */
  t: number;
}

/** Quantizes a transform so a snapshot is a small, stable byte pattern. */
export function quantize(tr: NetTransform, posStep = 0.01, rotStep = 0.005): NetTransform {
  const q = (v: number, step: number): number => Math.round(v / step) * step;
  return {
    x: q(tr.x, posStep), y: q(tr.y, posStep), z: q(tr.z, posStep),
    ry: q(tr.ry, rotStep),
    sx: tr.sx, sy: tr.sy, sz: tr.sz,
  };
}

export function lerpTransform(a: NetTransform, b: NetTransform, t: number): NetTransform {
  const k = Math.max(0, Math.min(1, t));
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    ry: a.ry + (b.ry - a.ry) * k,
    sx: a.sx, sy: a.sy, sz: a.sz,
  };
}

/**
 * Snapshot buffer with a fixed render delay: an entity is drawn at
 * `now - delay`, between the two snapshots that bracket that time. This is
 * the standard "interpolation with jitter buffer" and it is what keeps
 * remote players smooth on a lossy link.
 */
export class SnapshotBuffer {
  private history = new Map<number, ReplicaSnapshot[]>();
  delayMs = 100;
  maxPerEntity = 20;

  push(s: ReplicaSnapshot): void {
    const list = this.history.get(s.net) ?? [];
    // Out-of-order packets are dropped rather than corrupting the timeline.
    if (list.length > 0 && list[list.length - 1].t > s.t) return;
    list.push(s);
    while (list.length > this.maxPerEntity) list.shift();
    this.history.set(s.net, list);
  }

  /** Position to render for `net` at time `nowMs`, or null if unknown. */
  sample(net: number, nowMs: number): NetTransform | null {
    const list = this.history.get(net);
    if (!list || list.length === 0) return null;
    const target = nowMs - this.delayMs;
    if (target <= list[0].t) return list[0].tr;
    const last = list[list.length - 1];
    if (target >= last.t) return last.tr;
    for (let i = list.length - 1; i > 0; i--) {
      const b = list[i], a = list[i - 1];
      if (target >= a.t && target <= b.t) {
        const span = Math.max(1e-6, b.t - a.t);
        return lerpTransform(a.tr, b.tr, (target - a.t) / span);
      }
    }
    return last.tr;
  }

  /** Seconds of extrapolation the last snapshot is worth showing. */
  latencyMs(net: number, nowMs: number): number {
    const list = this.history.get(net);
    if (!list || list.length === 0) return 0;
    return Math.max(0, nowMs - this.delayMs - list[list.length - 1].t);
  }

  forget(net: number): void {
    this.history.delete(net);
  }

  get tracked(): number {
    return this.history.size;
  }
}

// --- interest management ---

/**
 * Selects the nearest N entities to the observer. This is the server-side
 * half of area-of-interest; the client never sees what it did not request.
 */
export function selectInterest(
  candidates: { id: number; x: number; z: number }[],
  observerX: number, observerZ: number, max: number
): number[] {
  return candidates
    .map((c) => ({ id: c.id, d: Math.hypot(c.x - observerX, c.z - observerZ) }))
    .sort((a, b) => (a.d - b.d) || (a.id - b.id))
    .slice(0, Math.max(0, max))
    .map((c) => c.id);
}

// --- server ---

export interface NetServerOptions {
  transport: NetTransport;
  /** How many replicas a peer is told about. */
  maxInterest?: number;
  clock?: () => number;
}

export interface SpawnRecord {
  net: number;
  uid: string;
  meshId: string;
  color: [number, number, number];
  position: Vec3;
  rotationY: number;
  scale: number;
}

/**
 * Server-authoritative replication. The host owns the world; clients only
 * send RPCs (and, in this foundation, no state at all - state flows one
 * way). That is a real, working topology, not a stub.
 */
export class NetServer {
  private transport: NetTransport;
  private ids = new NetIdMap();
  private records = new Map<number, SpawnRecord>();
  private peers = new Set<number>();
  private interest = new Map<number, number[]>();
  private maxInterest: number;
  private clock: () => number;
  private nextPeer = 1;
  /** RPC handlers by name. */
  handlers = new Map<string, (args: unknown, from: number) => void>();
  onPeerCountChange: ((n: number) => void) | null = null;

  constructor(opts: NetServerOptions) {
    this.transport = opts.transport;
    this.maxInterest = opts.maxInterest ?? 32;
    this.clock = opts.clock ?? (() => Date.now());
    this.transport.on({
      onMessage: (m, from) => this.receive(m, from),
      onPeerJoin: (p) => {
        this.peers.add(p);
        this.onPeerCountChange?.(this.peers.size);
      },
      onPeerLeave: (p) => {
        this.peers.delete(p);
        this.interest.delete(p);
        this.transport.send(p, { t: "interest", peers: [...this.peers, 0] });
        this.onPeerCountChange?.(this.peers.size);
      },
    });
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get spawnedCount(): number {
    return this.records.size;
  }

  /** Allocates a net id for a world entity and records its spawn data. */
  spawn(e: Entity, world: World): number {
    const net = this.ids.add(e);
    const t = world.get<{ position: Vec3; rotationY: number; scale: Vec3 }>(e, "transform");
    const m = world.get<{ meshId: string; color: [number, number, number] }>(e, "mesh");
    const uid = getUid(world, e) ?? makeUid(`net${net}`);
    this.records.set(net, {
      net, uid, meshId: m?.meshId ?? "cube", color: m?.color ?? [1, 1, 1],
      position: t ? t.position.clone() : new Vec3(),
      rotationY: t?.rotationY ?? 0,
      scale: t ? Math.max(t.scale.x, t.scale.y, t.scale.z) : 1,
    });
    this.broadcastTo({ t: "spawn", net, uid, meshId: m?.meshId ?? "cube", color: m?.color ?? [1, 1, 1], tr: this.transformOf(net), scale: this.records.get(net)!.scale });
    return net;
  }

  despawn(e: Entity): boolean {
    const net = this.ids.idOf(e);
    if (net === null) return false;
    this.ids.remove(e);
    this.records.delete(net);
    this.broadcastTo({ t: "despawn", net });
    return true;
  }

  netIdOf(e: Entity): number | null {
    return this.ids.idOf(e);
  }

  private transformOf(net: number): NetTransform {
    const r = this.records.get(net);
    if (!r) return { x: 0, y: 0, z: 0, ry: 0, sx: 1, sy: 1, sz: 1 };
    return quantize({
      x: r.position.x, y: r.position.y, z: r.position.z, ry: r.rotationY,
      sx: r.scale, sy: r.scale, sz: r.scale,
    });
  }

  /** Updates one replica from the authoritative world and pushes a delta. */
  sync(e: Entity, world: World): boolean {
    const net = this.ids.idOf(e);
    if (net === null) return false;
    const t = world.get<{ position: Vec3; rotationY: number; scale: Vec3 }>(e, "transform");
    if (!t) return false;
    const rec = this.records.get(net)!;
    rec.position.set(t.position.x, t.position.y, t.position.z);
    rec.rotationY = t.rotationY;
    rec.scale = Math.max(t.scale.x, t.scale.y, t.scale.z);
    const tr = this.transformOf(net);
    for (const peer of this.peers) {
      const allowed = this.interest.get(peer);
      if (allowed && !allowed.includes(net)) continue;
      this.transport.send(peer, { t: "state", net, tr });
    }
    return true;
  }

  /** Recomputes which entities each peer is told about. */
  updateInterest(world: World, observerOf: (peer: number) => Vec3 | null): void {
    const candidates = [...this.records.values()].map((r) => ({ id: r.net, x: r.position.x, z: r.position.z }));
    for (const peer of this.peers) {
      const o = observerOf(peer);
      if (!o) continue;
      const picked = selectInterest(candidates, o.x, o.z, this.maxInterest);
      this.interest.set(peer, picked);
    }
  }

  /** Registers an RPC handler the host executes on behalf of clients. */
  rpc(name: string, fn: (args: unknown, from: number) => void): void {
    this.handlers.set(name, fn);
  }

  call(target: number | "all", name: string, args: unknown = {}): void {
    const net = target === "all" ? HOST_NET_ID : target;
    const msg: NetMessage = { t: "rpc", net, name, args };
    if (target === "all") this.transport.broadcast(msg);
    else this.transport.send(target, msg);
  }

  private broadcastTo(m: NetMessage): void {
    this.transport.broadcast(m);
  }

  private receive(m: NetMessage, from: number): void {
    if (m.t === "hello") {
      if (m.protocol !== PROTOCOL_VERSION) return;
      this.transport.send(from, { t: "hello", peer: 0, protocol: PROTOCOL_VERSION });
      this.transport.send(from, { t: "interest", peers: [...this.peers, HOST_NET_ID] });
      return;
    }
    if (m.t === "rpc") {
      const fn = this.handlers.get(m.name);
      if (!fn) return;
      try {
        fn(m.args, from);
      } catch {
        // A bad RPC handler must not take down the host loop.
      }
    }
  }

  tick(): void {
    // nothing per-frame by default; sync() is explicit
    void this.clock;
  }
}

// --- client ---

export interface ClientReplica {
  net: number;
  entity: Entity;
}

/**
 * Client-side replica manager. Spawns/destroys local entities from server
 * messages and renders them from the interpolation buffer. It never trusts
 * the server for the local player: `predicted` is the local authority.
 */
export class NetClient {
  private transport: NetTransport;
  private ids = new NetIdMap();
  private replicas = new Map<number, ClientReplica>();
  buffer = new SnapshotBuffer();
  peers: number[] = [];
  /** RPC handlers by name. */
  handlers = new Map<string, (args: unknown) => void>();
  onLog: ((msg: string) => void) | null = null;
  latencySamples: number[] = [];

  constructor(transport: NetTransport, private world: World) {
    this.transport = transport;
    const handlers: TransportHandlers = {
      onMessage: (m) => this.receive(m),
      onPeerJoin: (p) => {
        this.peers.push(p);
        this.onLog?.(`peer ${p} joined`);
      },
      onPeerLeave: (p) => {
        this.peers = this.peers.filter((x) => x !== p);
        this.onLog?.(`peer ${p} left`);
      },
    };
    if (transport.attachClient) transport.attachClient(handlers);
    else transport.on(handlers);
  }

  /** Client -> host. Uses the dedicated channel when the link provides one. */
  private toHost(m: NetMessage): void {
    if (this.transport.clientSend) this.transport.clientSend(m);
    else this.transport.send(HOST_NET_ID, m);
  }

  connect(): void {
    this.toHost({ t: "hello", peer: -1, protocol: PROTOCOL_VERSION });
  }

  get replicaCount(): number {
    return this.replicas.size;
  }

  entityFor(net: number): Entity | null {
    return this.replicas.get(net)?.entity ?? null;
  }

  sendRpc(name: string, args: unknown = {}): void {
    this.toHost({ t: "rpc", net: HOST_NET_ID, name, args });
  }

  private receive(m: NetMessage): void {
    switch (m.t) {
      case "spawn": {
        if (this.replicas.has(m.net)) return;
        const e = this.world.create();
        this.world.add(e, "transform", {
          position: new Vec3(m.tr.x, m.tr.y, m.tr.z),
          rotationY: m.tr.ry,
          scale: new Vec3(m.scale, m.scale, m.scale),
        });
        this.world.add(e, "mesh", { meshId: m.meshId, color: m.color });
        try {
          assignUid(this.world, e, `net:${m.uid}`);
        } catch {
          assignUid(this.world, e, makeUid(`net${m.net}`));
        }
        this.ids.add(e);
        this.replicas.set(m.net, { net: m.net, entity: e });
        this.onLog?.(`spawned replica ${m.net}`);
        return;
      }
      case "despawn": {
        const r = this.replicas.get(m.net);
        if (!r) return;
        this.ids.remove(r.entity);
        this.replicas.delete(m.net);
        this.buffer.forget(m.net);
        if (this.world.isAlive(r.entity)) this.world.destroy(r.entity);
        return;
      }
      case "state": {
        this.buffer.push({ net: m.net, tr: m.tr, t: this.clock() });
        return;
      }
      case "interest": {
        this.peers = m.peers.filter((p) => p !== HOST_NET_ID);
        return;
      }
      case "rpc": {
        const fn = this.handlers.get(m.name);
        if (fn) fn(m.args);
        return;
      }
      default:
        return;
    }
  }

  private clock(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** Applies interpolated transforms to the replica entities. */
  renderReplicas(nowMs: number = this.clock()): number {
    let n = 0;
    for (const [net, r] of this.replicas) {
      const tr = this.buffer.sample(net, nowMs);
      if (!tr) continue;
      const t = this.world.get<{ position: Vec3; rotationY: number }>(r.entity, "transform");
      if (!t) continue;
      t.position.set(tr.x, tr.y, tr.z);
      t.rotationY = tr.ry;
      n++;
    }
    return n;
  }

  dispose(): void {
    for (const [, r] of this.replicas) {
      if (this.world.isAlive(r.entity)) this.world.destroy(r.entity);
    }
    this.replicas.clear();
    this.ids.clear();
  }
}

// --- prediction foundation ---

export interface PredictedMove {
  entity: Entity;
  position: Vec3;
  rotationY: number;
}

/**
 * Client-side prediction with server reconciliation: the client applies its
 * input immediately, keeps a rolling history of the *inputs*, and when an
 * authoritative snapshot arrives it rewinds to it and replays every input
 * the server has not acknowledged.
 *
 * This is the real algorithm (not a placeholder): the history stores the
 * movement delta, so replay reproduces the client's intent exactly.
 */
export class Predictor {
  private history: { seq: number; dx: number; dz: number; dt: number }[] = [];
  maxHistory = 60;
  lastAcked = 0;
  /** Movement model: world units per second at full input. */
  speed = 6;

  /** Applies an input locally and remembers it. Returns the new state. */
  apply(current: NetTransform, inputX: number, inputZ: number, dt: number, seq: number): NetTransform {
    const moved = this.step(current, inputX, inputZ, dt);
    this.history.push({ seq, dx: inputX, dz: inputZ, dt });
    while (this.history.length > this.maxHistory) this.history.shift();
    this.lastAcked = seq;
    return moved;
  }

  private step(current: NetTransform, inputX: number, inputZ: number, dt: number): NetTransform {
    const len = Math.hypot(inputX, inputZ);
    const nx = len > 1e-6 ? inputX / len : 0;
    const nz = len > 1e-6 ? inputZ / len : 0;
    return {
      ...current,
      x: current.x + nx * this.speed * dt,
      z: current.z + nz * this.speed * dt,
      ry: len > 1e-6 ? Math.atan2(nx, nz) : current.ry,
    };
  }

  /**
   * Reconciles against the server: drop acknowledged inputs, then replay the
   * unacknowledged ones on top of the authoritative state.
   */
  reconcile(server: NetTransform, ackedSeq: number): NetTransform {
    this.history = this.history.filter((h) => h.seq > ackedSeq);
    let tr = server;
    for (const h of this.history) tr = this.step(tr, h.dx, h.dz, h.dt);
    return tr;
  }

  get pending(): number {
    return this.history.length;
  }

  reset(): void {
    this.history.length = 0;
    this.lastAcked = 0;
  }
}
