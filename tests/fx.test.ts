import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import type { Transform } from "../src/ecs/components.js";
import { ParticleSystem, coneDir, type EmitterDef, type Particle } from "../src/fx/particles.js";

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseDef(over: Partial<EmitterDef> = {}): EmitterDef {
  return {
    rate: 0, burst: 0, duration: 0, looping: false,
    life: [1, 1], speed: [0, 0], direction: new Vec3(0, 1, 0), spread: 0,
    size: [0.2, 0.2], growth: 0,
    colorStart: [1, 0, 0], colorEnd: [0, 0, 1],
    gravity: 0, drag: 0, bounce: 0, meshId: "cube",
    ...over,
  };
}

function aliveParticles(world: World): { e: number; p: Particle }[] {
  const out: { e: number; p: Particle }[] = [];
  for (const e of world.query("transform", "mesh", "particle")) {
    const p = world.get<Particle>(e, "particle")!;
    if (p.alive) out.push({ e, p });
  }
  return out;
}

describe("emission", () => {
  it("emits at rate and kills at end of life, recycling the pool", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 64);
    sys.attach(baseDef({ rate: 10, life: [10, 10] }), 0, 1, 0, { rand: seeded(1) });
    for (let i = 0; i < 10; i++) sys.update(0.1);
    expect(sys.aliveCount).toBe(10);
    sys.clear();
    expect(sys.aliveCount).toBe(0);
    const n = sys.burst(baseDef({ life: [0.2, 0.2] }), 0, 1, 0, 5, seeded(2));
    expect(n).toBe(5);
    sys.update(1.0);
    expect(sys.aliveCount).toBe(0);
    // pool recycled: can burst again to full
    expect(sys.burst(baseDef({ life: [5, 5] }), 0, 1, 0, 5, seeded(2))).toBe(5);
  });

  it("caps at pool size", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 4);
    expect(sys.burst(baseDef({ life: [5, 5] }), 0, 1, 0, 10, seeded(3))).toBe(4);
    expect(sys.aliveCount).toBe(4);
  });

  it("expires finite emitters but lets particles live out", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 64);
    sys.attach(baseDef({ rate: 100, duration: 0.2, life: [1, 1] }), 0, 1, 0, { rand: seeded(4) });
    sys.update(0.1);
    expect(sys.emitterCount).toBe(1);
    sys.update(0.5);
    expect(sys.emitterCount).toBe(0);
    expect(sys.aliveCount).toBeGreaterThan(0);
  });
});

describe("motion", () => {
  it("integrates velocity and gravity", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 8);
    sys.burst(baseDef({ life: [5, 5], speed: [2, 2], direction: new Vec3(1, 0, 0), spread: 0, gravity: -10 }), 0, 5, 0, 1, seeded(5));
    const [{ p }] = aliveParticles(world);
    sys.update(0.5);
    expect(p.vx).toBeCloseTo(2);
    expect(p.vy).toBeCloseTo(-5);
  });

  it("bounces or dies on the ground", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 8);
    sys.burst(baseDef({ life: [5, 5], speed: [0, 0], gravity: -20, bounce: 0 }), 0, 1, 0, 1, seeded(6));
    sys.update(1.0);
    expect(sys.aliveCount).toBe(0); // fell through y=0 and died
    sys.burst(baseDef({ life: [5, 5], speed: [0, 0], gravity: -20, bounce: 0.8 }), 0, 3, 0, 1, seeded(6));
    sys.update(0.4);
    expect(sys.aliveCount).toBe(1); // bounced, still alive
  });

  it("drags velocity toward zero", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 8);
    sys.burst(baseDef({ life: [5, 5], speed: [10, 10], direction: new Vec3(1, 0, 0), spread: 0, drag: 10 }), 0, 5, 0, 1, seeded(7));
    const before = aliveParticles(world)[0].p.vx;
    sys.update(0.5);
    expect(aliveParticles(world)[0].p.vx).toBeLessThan(before * 0.2);
  });
});

describe("appearance", () => {
  it("lerps color and grows size over life", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 8);
    sys.burst(baseDef({ life: [1, 1], speed: [0, 0], size: [0.2, 0.2], growth: 0.2 }), 0, 5, 0, 1, seeded(8));
    sys.update(0.5);
    const [{ e }] = aliveParticles(world);
    const m = world.get<{ color: [number, number, number] }>(e, "mesh")!;
    expect(m.color[0]).toBeCloseTo(0.5, 1);
    expect(m.color[2]).toBeCloseTo(0.5, 1);
    const t = world.get<Transform>(e, "transform")!;
    expect(t.scale.x).toBeCloseTo(0.3, 2);
  });
});

describe("emitters", () => {
  it("follow entities and keep stable ids across pruning", () => {
    const world = new World();
    const sys = new ParticleSystem(world, 64);
    const mover = world.create();
    world.add(mover, "transform", makeTransform(0, 1, 0));
    sys.attach(baseDef({ rate: 10, duration: 0.1, life: [5, 5] }), 0, 0, 0, { rand: seeded(9) });
    const followId = sys.attach(
      baseDef({ rate: 100, life: [5, 5], speed: [0, 0] }), 0, 0, 0,
      { follow: mover, rand: seeded(9) }
    );
    expect(sys.emitterCount).toBe(2);
    world.get<Transform>(mover, "transform")!.position.set(20, 1, 0);
    sys.update(0.05);
    const xs = aliveParticles(world).map(({ e }) => world.get<Transform>(e, "transform")!.position.x);
    expect(xs.some((x) => Math.abs(x - 20) < 0.6)).toBe(true);
    sys.update(0.5); // finite emitter expires, follower survives
    expect(sys.emitterCount).toBe(1);
    sys.moveEmitter(followId, 9, 9, 9); // stable id still valid after pruning
    sys.detachEmitter(followId);
    expect(sys.emitterCount).toBe(0);
  });
});

describe("coneDir", () => {
  it("returns the axis for zero spread", () => {
    const d = coneDir(new Vec3(0, 0, 2), 0, seeded(10));
    expect([d.x, d.y, d.z]).toEqual([0, 0, 1]);
  });

  it("stays inside the cone and is deterministic", () => {
    const a = coneDir(new Vec3(0, 1, 0), Math.PI / 4, seeded(11));
    const b = coneDir(new Vec3(0, 1, 0), Math.PI / 4, seeded(11));
    expect([a.x, a.y, a.z]).toEqual([b.x, b.y, b.z]);
    expect(a.y).toBeGreaterThanOrEqual(Math.cos(Math.PI / 4) - 1e-6);
    expect(Math.abs(a.length() - 1)).toBeLessThan(1e-6);
  });
});
