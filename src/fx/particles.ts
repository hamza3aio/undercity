// Glitch particles — CPU simulation, engine-drawn presentation.
// Particles are ordinary entities (transform + mesh + "particle" component),
// so frustum culling and the instancing batcher apply automatically: a few
// hundred live particles typically cost one draw call. Emitters are runtime
// objects (not serialized); bursts are one-shot emitters under the hood.

import { World, type Entity } from "../ecs/world.js";
import { Vec3 } from "../math/vec3.js";
import { makeTransform, type MeshRef } from "../ecs/components.js";

export const PARTICLE_COMPONENT = "particle";

export interface Particle {
  alive: boolean;
  age: number;
  life: number;
  vx: number; vy: number; vz: number;
  size: number;
  growth: number;
  gravity: number;
  drag: number;
  bounce: number; // 0 = die on ground contact, >0 = velocity kept as fraction
  r0: number; g0: number; b0: number;
  r1: number; g1: number; b1: number;
}

export interface EmitterDef {
  rate: number; // particles per second, 0 = burst-only
  burst: number; // immediate particles on attach
  duration: number; // seconds, 0 = infinite
  looping: boolean;
  life: [number, number];
  speed: [number, number];
  direction: Vec3; // cone axis (need not be normalized)
  spread: number; // cone half-angle, radians, 0 = straight beam
  size: [number, number];
  growth: number; // units per second (negative shrinks)
  colorStart: [number, number, number];
  colorEnd: [number, number, number];
  gravity: number; // added to vy per second (negative falls)
  drag: number; // velocity *= max(0, 1 - drag*dt)
  bounce: number;
  meshId: string;
}

export type Rand = () => number;

// Ready-made fountain emitter definition for demos and the editor.
export function fountainDef(): EmitterDef {
  return {
    rate: 40, burst: 0, duration: 0, looping: false,
    life: [0.8, 1.4], speed: [3, 5], direction: new Vec3(0, 1, 0), spread: 0.35,
    size: [0.08, 0.16], growth: -0.02,
    colorStart: [1.0, 0.75, 0.25], colorEnd: [0.9, 0.25, 0.1],
    gravity: -7, drag: 0.4, bounce: 0.5, meshId: "cube",
  };
}

interface Emitter {
  id: number;
  def: EmitterDef;
  x: number; y: number; z: number;
  follow: Entity | null;
  age: number;
  accum: number;
  rand: Rand;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class ParticleSystem {
  private pool: Entity[] = [];
  private emitters: Emitter[] = [];
  private nextId = 1;

  constructor(private world: World, private max = 256, private meshDefault = "cube") {
    for (let i = 0; i < max; i++) {
      const e = world.create();
      this.pool.push(e);
      const t = makeTransform(0, -10, 0);
      t.scale.set(0.001, 0.001, 0.001);
      world.add(e, "transform", t);
      world.add<MeshRef>(e, "mesh", { meshId: meshDefault, color: [1, 1, 1] });
      world.add<Particle>(e, PARTICLE_COMPONENT, {
        alive: false, age: 0, life: 1,
        vx: 0, vy: 0, vz: 0, size: 0.1, growth: 0,
        gravity: 0, drag: 0, bounce: 0,
        r0: 1, g0: 1, b0: 1, r1: 1, g1: 1, b1: 1,
      });
    }
  }

  get aliveCount(): number {
    let n = 0;
    for (const e of this.pool) {
      if (this.world.get<Particle>(e, PARTICLE_COMPONENT)?.alive) n++;
    }
    return n;
  }

  get emitterCount(): number {
    return this.emitters.length;
  }

  attach(def: EmitterDef, x: number, y: number, z: number, opts: { follow?: Entity | null; rand?: Rand } = {}): number {
    const rand = opts.rand ?? Math.random;
    const id = this.nextId++;
    const em: Emitter = {
      id, def, x, y, z,
      follow: opts.follow ?? null,
      age: 0, accum: 0, rand,
    };
    this.emitters.push(em);
    for (let i = 0; i < def.burst; i++) this.spawn(em);
    return id;
  }

  // One-shot burst. Returns entities spawned.
  burst(def: EmitterDef, x: number, y: number, z: number, n: number, rand: Rand = Math.random): number {
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      if (this.spawnOne(def, x, y, z, rand)) spawned++;
    }
    return spawned;
  }

  moveEmitter(id: number, x: number, y: number, z: number): void {
    const em = this.emitters.find((e) => e.id === id);
    if (em) { em.x = x; em.y = y; em.z = z; }
  }

  detachEmitter(id: number): void {
    this.emitters = this.emitters.filter((e) => e.id !== id);
  }

  // Returns { emitted, alive } for HUD/profiling.
  update(dt: number): { emitted: number; alive: number } {
    let emitted = 0;
    const keep: Emitter[] = [];
    for (const em of this.emitters) {
      em.age += dt;
      if (em.follow !== null) {
        const t = this.world.get<{ position: Vec3 }>(em.follow, "transform");
        if (t) { em.x = t.position.x; em.y = t.position.y; em.z = t.position.z; }
        else em.follow = null;
      }
      const active = em.def.duration <= 0 || em.def.looping || em.age <= em.def.duration;
      if (active && em.def.rate > 0) {
        em.accum += em.def.rate * dt;
        while (em.accum >= 1) {
          em.accum -= 1;
          if (this.spawn(em)) emitted++;
          else { em.accum = 0; break; } // pool exhausted: drop the backlog
        }
      }
      if (em.def.duration > 0 && !em.def.looping && em.age > em.def.duration) continue;
      keep.push(em);
    }
    this.emitters = keep;

    let alive = 0;
    for (const e of this.pool) {
      const p = this.world.get<Particle>(e, PARTICLE_COMPONENT)!;
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        const t = this.world.get<{ position: Vec3; scale: Vec3 }>(e, "transform")!;
        t.position.set(0, -10, 0);
        t.scale.set(0.001, 0.001, 0.001);
        continue;
      }
      p.vy += p.gravity * dt;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.vx *= damp; p.vy *= damp; p.vz *= damp;
      const t = this.world.get<{ position: Vec3; scale: Vec3 }>(e, "transform")!;
      t.position.x += p.vx * dt;
      t.position.y += p.vy * dt;
      t.position.z += p.vz * dt;
      const half = Math.max(0.01, p.size / 2);
      if (t.position.y - half <= 0) {
        if (p.bounce > 0 && Math.abs(p.vy) > 0.5) {
          t.position.y = half;
          p.vy = -p.vy * p.bounce;
        } else if (p.bounce > 0) {
          t.position.y = half;
          p.vy = 0;
        } else {
          p.alive = false;
          t.position.set(0, -10, 0);
          t.scale.set(0.001, 0.001, 0.001);
          continue;
        }
      }
      const s = Math.max(0.01, p.size + p.growth * p.age);
      t.scale.set(s, s, s);
      const f = p.age / p.life;
      const m = this.world.get<MeshRef>(e, "mesh")!;
      m.color = [lerp(p.r0, p.r1, f), lerp(p.g0, p.g1, f), lerp(p.b0, p.b1, f)];
      alive++;
    }
    return { emitted, alive };
  }

  clear(): void {
    for (const e of this.pool) {
      const p = this.world.get<Particle>(e, PARTICLE_COMPONENT)!;
      p.alive = false;
      const t = this.world.get<{ position: Vec3; scale: Vec3 }>(e, "transform")!;
      t.position.set(0, -10, 0);
      t.scale.set(0.001, 0.001, 0.001);
    }
    this.emitters = [];
  }

  private spawn(em: Emitter): boolean {
    return this.spawnOne(em.def, em.x, em.y, em.z, em.rand);
  }

  private spawnOne(def: EmitterDef, x: number, y: number, z: number, rand: Rand): boolean {
    for (const e of this.pool) {
      const p = this.world.get<Particle>(e, PARTICLE_COMPONENT)!;
      if (p.alive) continue;
      const life = lerp(def.life[0], def.life[1], rand());
      const speed = lerp(def.speed[0], def.speed[1], rand());
      const dir = coneDir(def.direction, def.spread, rand);
      const size = lerp(def.size[0], def.size[1], rand());
      p.alive = true;
      p.age = 0;
      p.life = Math.max(0.01, life);
      p.vx = dir.x * speed; p.vy = dir.y * speed; p.vz = dir.z * speed;
      p.size = size;
      p.growth = def.growth;
      p.gravity = def.gravity;
      p.drag = def.drag;
      p.bounce = def.bounce;
      p.r0 = def.colorStart[0]; p.g0 = def.colorStart[1]; p.b0 = def.colorStart[2];
      p.r1 = def.colorEnd[0]; p.g1 = def.colorEnd[1]; p.b1 = def.colorEnd[2];
      const t = this.world.get<{ position: Vec3; scale: Vec3 }>(e, "transform")!;
      t.position.set(x, y, z);
      t.scale.set(Math.max(0.01, size), Math.max(0.01, size), Math.max(0.01, size));
      const m = this.world.get<MeshRef>(e, "mesh")!;
      m.meshId = def.meshId;
      m.color = [p.r0, p.g0, p.b0];
      return true;
    }
    return false; // pool exhausted
  }
}

// Uniform direction inside a cone around `axis` (any length) with half-angle
// `spread`. Spread 0 returns the axis exactly.
export function coneDir(axis: Vec3, spread: number, rand: Rand): Vec3 {
  const w = axis.clone().normalize();
  if (!(spread > 0)) return w;
  const cosMax = Math.cos(Math.min(spread, Math.PI));
  const cosA = 1 - rand() * (1 - cosMax);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const theta = rand() * Math.PI * 2;
  const ref = Math.abs(w.y) < 0.99 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
  const u = ref.cross(w).normalize();
  const v = w.cross(u).normalize();
  return new Vec3(
    w.x * cosA + (u.x * Math.cos(theta) + v.x * Math.sin(theta)) * sinA,
    w.y * cosA + (u.y * Math.cos(theta) + v.y * Math.sin(theta)) * sinA,
    w.z * cosA + (u.z * Math.cos(theta) + v.z * Math.sin(theta)) * sinA
  ).normalize();
}
