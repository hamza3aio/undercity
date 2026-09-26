import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { Physics } from "../src/physics/physics.js";
import { makeTrigger } from "../src/physics/trigger.js";
import { TriggerSystem } from "../src/physics/trigger.js";
import { raycastScene } from "../src/physics/raycast.js";
import { CharacterController } from "../src/physics/character.js";
import { getLayer, layerBit, setLayer, setMask } from "../src/physics/layers.js";
import type { CapsuleCollider, SphereCollider } from "../src/ecs/components.js";
import { makeRigidbody, makeTransform } from "../src/ecs/components.js";
import type { Rigidbody, Transform } from "../src/ecs/components.js";

function dynamicBox(w: World, x: number, y: number, z: number) {
  const e = w.create();
  w.add(e, "transform", makeTransform(x, y, z));
  w.add(e, "rigidbody", makeRigidbody(true, 1));
  w.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
  return e;
}

function staticBox(w: World, x: number, y: number, z: number, hx = 0.5, hy = 0.5, hz = 0.5) {
  const e = w.create();
  const t = makeTransform(x, y, z);
  t.scale.set(hx * 2, hy * 2, hz * 2);
  w.add(e, "transform", t);
  w.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });
  return e;
}

describe("Physics", () => {
  it("falls under gravity and lands on the ground plane", () => {
    const w = new World();
    const phys = new Physics();
    const e = dynamicBox(w, 0, 5, 0);
    for (let i = 0; i < 120; i++) phys.step(w, 1 / 60);
    const t = w.get<Transform>(e, "transform")!;
    const rb = w.get<Rigidbody>(e, "rigidbody")!;
    expect(t.position.y).toBeCloseTo(0.5, 1);
    expect(rb.grounded).toBe(true);
    expect(rb.velocity.y).toBe(0);
  });

  it("lands on top of static boxes", () => {
    const w = new World();
    const phys = new Physics();
    staticBox(w, 0, 0.5, 0, 2, 0.5, 2); // top surface at y=1
    const e = dynamicBox(w, 0, 5, 0);
    for (let i = 0; i < 180; i++) phys.step(w, 1 / 60);
    const t = w.get<Transform>(e, "transform")!;
    expect(t.position.y).toBeCloseTo(1.5, 1);
  });

  it("pushes out sideways on side impact and zeroes that velocity", () => {
    const w = new World();
    const phys = new Physics();
    staticBox(w, 5, 2, 0, 0.5, 2, 0.5); // wall
    const e = dynamicBox(w, 0, 2, 0);
    const rb = w.get<Rigidbody>(e, "rigidbody")!;
    rb.useGravity = false;
    rb.velocity.x = 10;
    for (let i = 0; i < 60; i++) phys.step(w, 1 / 60);
    const t = w.get<Transform>(e, "transform")!;
    expect(t.position.x).toBeLessThan(5);
    expect(rb.velocity.x).toBe(0);
  });

  it("prunes per-entity state when bodies are destroyed", () => {
    const w = new World();
    const phys = new Physics();
    const e = dynamicBox(w, 0, 5, 0);
    for (let i = 0; i < 120; i++) phys.step(w, 1 / 60);
    const before = (phys as unknown as { wasGrounded: Map<number, boolean> }).wasGrounded.size;
    expect(before).toBeGreaterThan(0);
    w.destroy(e);
    phys.step(w, 1 / 60);
    expect((phys as unknown as { wasGrounded: Map<number, boolean> }).wasGrounded.size).toBe(0);
  });
});

describe("TriggerSystem", () => {
  it("fires enter once and exit on leave, and prunes destroyed bodies", () => {
    const w = new World();
    const sys = new TriggerSystem();
    const tr = w.create();
    w.add(tr, "transform", makeTransform(0, 0, 0));
    w.add(tr, "trigger", makeTrigger(2, 2, 2));
    const body = dynamicBox(w, 10, 0, 0);
    const events: string[] = [];
    sys.onEnter = (t, o) => events.push(`enter ${t} ${o}`);
    sys.onExit = (t, o) => events.push(`exit ${t} ${o}`);
    sys.update(w);
    expect(events).toEqual([]);
    w.get<Transform>(body, "transform")!.position.set(0, 0, 0);
    sys.update(w);
    expect(events).toEqual([`enter ${tr} ${body}`]);
    sys.update(w);
    expect(events).toHaveLength(1); // no repeat
    w.destroy(body);
    sys.update(w);
    expect(events[events.length - 1]).toBe(`exit ${tr} ${body}`);
  });
});

describe("raycast", () => {
  it("hits the closest box and misses empty space", () => {
    const w = new World();
    staticBox(w, 0, 1, -5);
    const hit = raycastScene(w, {
      origin: new Vec3(0, 1, 0),
      direction: new Vec3(0, 0, -1),
      maxDist: 50,
    });
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(4.5, 1);
    const miss = raycastScene(w, {
      origin: new Vec3(0, 1, 0),
      direction: new Vec3(0, 1, 0),
      maxDist: 50,
    });
    expect(miss).toBeNull();
  });
});

describe("CharacterController", () => {
  it("drives velocity toward wish*speed and jumps when grounded", () => {
    const w = new World();
    const e = dynamicBox(w, 0, 1, 0);
    const t = w.get<Transform>(e, "transform")!;
    const rb = w.get<Rigidbody>(e, "rigidbody")!;
    rb.grounded = true;
    const ctl = new CharacterController({ speed: 6, jumpSpeed: 8, acceleration: 40 });
    for (let i = 0; i < 60; i++) ctl.move(t, rb, 1, 0, false, 1 / 60);
    expect(rb.velocity.x).toBeCloseTo(6, 0);
    let jumped = false;
    ctl.move(t, rb, 0, 0, true, 1 / 60, () => { jumped = true; });
    expect(jumped).toBe(true);
    expect(rb.velocity.y).toBe(8);
  });
});

function dynSphere(w: World, x: number, y: number, z: number, r: number) {
  const e = w.create();
  w.add(e, "transform", makeTransform(x, y, z));
  w.add(e, "rigidbody", makeRigidbody(true, 1));
  w.add(e, "sphere", { radius: r, isStatic: false } as SphereCollider);
  return e;
}

function staticSphere(w: World, x: number, y: number, z: number, r: number) {
  const e = w.create();
  w.add(e, "transform", makeTransform(x, y, z));
  w.add(e, "sphere", { radius: r, isStatic: true } as SphereCollider);
  return e;
}

function dynCapsule(w: World, x: number, y: number, z: number, r: number, h: number) {
  const e = w.create();
  w.add(e, "transform", makeTransform(x, y, z));
  w.add(e, "rigidbody", makeRigidbody(true, 1));
  w.add(e, "capsule", { radius: r, height: h, isStatic: false } as CapsuleCollider);
  return e;
}

function stepMany(w: World, phys: Physics, n: number) {
  for (let i = 0; i < n; i++) phys.step(w, 1 / 60);
}

describe("layers", () => {
  it("collides by default and passes through on disjoint layers", () => {
    const w = new World();
    const phys = new Physics();
    staticBox(w, 0, 2, 0, 2, 0.5, 2); // top at y=2.5
    const faller = dynamicBox(w, 0, 6, 0);
    stepMany(w, phys, 120);
    // default: lands on the box
    expect(w.get<Transform>(faller, "transform")!.position.y).toBeCloseTo(3.0, 1);

    const w2 = new World();
    const phys2 = new Physics();
    const s2 = staticBox(w2, 0, 2, 0, 2, 0.5, 2);
    setLayer(w2, s2, 2);
    setMask(w2, s2, layerBit(2));
    const f2 = dynamicBox(w2, 0, 6, 0);
    setLayer(w2, f2, 1);
    setMask(w2, f2, layerBit(1));
    stepMany(w2, phys2, 180);
    // disjoint: falls straight through to the ground plane
    expect(w2.get<Transform>(f2, "transform")!.position.y).toBeCloseTo(0.5, 1);
  });

  it("requires both masks (one-way still blocks nothing... i.e. blocks)", () => {
    const w = new World();
    const phys = new Physics();
    const s = staticBox(w, 0, 2, 0, 2, 0.5, 2);
    setLayer(w, s, 2);
    setMask(w, s, layerBit(2)); // static only sees layer 2
    const f = dynamicBox(w, 0, 6, 0);
    setLayer(w, f, 1);
    setMask(w, f, 0xffffffff); // faller sees everything, static doesn't see back
    stepMany(w, phys, 180);
    expect(w.get<Transform>(f, "transform")!.position.y).toBeCloseTo(0.5, 1);
    expect(getLayer(w, f)).toBe(1);
  });
});

describe("spheres", () => {
  it("rests on the ground at y=radius", () => {
    const w = new World();
    const phys = new Physics();
    const e = dynSphere(w, 0, 5, 0, 1);
    stepMany(w, phys, 120);
    const t = w.get<Transform>(e, "transform")!;
    expect(t.position.y).toBeCloseTo(1.0, 1);
    expect(w.get<Rigidbody>(e, "rigidbody")!.grounded).toBe(true);
  });

  it("lands on top of boxes and spheres", () => {
    const w = new World();
    const phys = new Physics();
    staticBox(w, 0, 0.5, 0, 2, 0.5, 2); // top y=1
    staticSphere(w, 5, 1, 0, 1); // top y=2
    const a = dynSphere(w, 0, 4, 0, 0.5);
    const b = dynSphere(w, 5, 5, 0, 0.5);
    stepMany(w, phys, 180);
    expect(w.get<Transform>(a, "transform")!.position.y).toBeCloseTo(1.5, 1);
    expect(w.get<Transform>(b, "transform")!.position.y).toBeCloseTo(2.5, 1);
  });
});

describe("capsules", () => {
  it("stands upright on the ground", () => {
    const w = new World();
    const phys = new Physics();
    const e = dynCapsule(w, 0, 5, 0, 0.5, 2); // halfH=0.5, rest y=1.0
    stepMany(w, phys, 150);
    expect(w.get<Transform>(e, "transform")!.position.y).toBeCloseTo(1.0, 1);
    expect(w.get<Rigidbody>(e, "rigidbody")!.grounded).toBe(true);
  });

  it("is pushed out by walls without grounding", () => {
    const w = new World();
    const phys = new Physics();
    staticBox(w, 3, 2, 0, 0.5, 2, 0.5);
    const e = dynCapsule(w, 0, 2, 0, 0.5, 2);
    const rb = w.get<Rigidbody>(e, "rigidbody")!;
    rb.useGravity = false;
    rb.velocity.x = 10;
    stepMany(w, phys, 60);
    const t = w.get<Transform>(e, "transform")!;
    expect(t.position.x).toBeLessThan(2.6);
    expect(rb.velocity.x).toBe(0);
    expect(rb.grounded).toBe(false);
  });
});

describe("raycast options", () => {
  it("respects masks, ignore and hits spheres with normals", () => {
    const w = new World();
    staticBox(w, 0, 1, -5);
    const far = staticBox(w, 0, 1, -8);
    setLayer(w, far, 1);
    const ray = { origin: new Vec3(0, 1, 0), direction: new Vec3(0, 0, -1), maxDist: 50 };
    // mask excludes layer 1 -> hits the near default-layer box
    const masked = raycastScene(w, ray, { mask: layerBit(0) });
    expect(masked!.distance).toBeCloseTo(4.5, 1);
    // no mask -> still nearest first
    expect(raycastScene(w, ray)!.distance).toBeCloseTo(4.5, 1);
    // ignore the near box -> sees the far one
    const near = w.query("transform", "collider").find((e) => {
      return w.get<Transform>(e, "transform")!.position.z === -5;
    })!;
    const skipped = raycastScene(w, ray, { ignore: near });
    expect(skipped!.distance).toBeCloseTo(7.5, 1);

    staticSphere(w, 4, 1, -5, 1);
    const sray = { origin: new Vec3(4, 1, 0), direction: new Vec3(0, 0, -1), maxDist: 50 };
    const shit = raycastScene(w, sray)!;
    expect(shit.distance).toBeCloseTo(4, 1);
    expect(shit.normal.z).toBeCloseTo(1);

    const down = raycastScene(w, { origin: new Vec3(0, 5, -5), direction: new Vec3(0, -1, 0), maxDist: 50 })!;
    expect(down.normal.y).toBeCloseTo(1);
  });
});
