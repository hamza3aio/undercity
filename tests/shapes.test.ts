import { describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform, type Transform } from "../src/ecs/components.js";
import {
  collectContacts, combineMaterials, compoundBounds, defaultPhysicsMaterials, makeCompound,
  overlapSphereWorld, raycastMeshes, sanitizePhysicsMaterial, sphereCastCompound, sphereCastWorld,
} from "../src/physics/shapes.js";
import { layerBit, setLayer, setMask } from "../src/physics/layers.js";

function wall(world: World, x = 5, z = 0, size = 1): number {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, 0, z));
  const t = world.get<Transform>(e, "transform")!;
  t.scale.set(size, size, size);
  world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });
  return e;
}

describe("physics materials", () => {
  it("ships sane presets", () => {
    const m = defaultPhysicsMaterials();
    expect(m.rubber.restitution).toBeGreaterThan(m.default.restitution);
    expect(m.ice.friction).toBeLessThan(m.metal.friction);
    expect(m.metal.density).toBeGreaterThan(m.wood.density);
  });

  it("clamps and fills defaults", () => {
    expect(sanitizePhysicsMaterial({ friction: 99, restitution: -1, density: 0 })).toMatchObject({
      friction: 2, restitution: 0, density: 0.01,
    });
    expect(sanitizePhysicsMaterial({}).name).toBe("custom");
  });

  it("combines contacts the way a solver would", () => {
    const m = defaultPhysicsMaterials();
    const c = combineMaterials(m.rubber, m.metal);
    expect(c.friction).toBeCloseTo(Math.sqrt(m.rubber.friction * m.metal.friction));
    expect(c.restitution).toBe(Math.max(m.rubber.restitution, m.metal.restitution));
  });
});

describe("sphereCastWorld", () => {
  it("hits a box and reports the face normal", () => {
    const world = new World();
    wall(world, 5, 0);
    const hit = sphereCastWorld(world, {
      origin: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.5, maxDist: 100,
    })!;
    expect(hit).not.toBeNull();
    expect(hit.distance).toBeCloseTo(4.0, 3); // 5 - 0.5 half - 0.5 radius
    expect(hit.normal.x).toBeCloseTo(-1);
    expect(hit.point.x).toBeCloseTo(4, 3);
  });

  it("misses when nothing is in the way and respects maxDist", () => {
    const world = new World();
    wall(world, 5, 0);
    expect(sphereCastWorld(world, { origin: new Vec3(0, 0, 0), direction: new Vec3(0, 0, 1), radius: 0.5, maxDist: 100 })).toBeNull();
    expect(sphereCastWorld(world, { origin: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.5, maxDist: 1 })).toBeNull();
  });

  it("returns the closest of several hits", () => {
    const world = new World();
    wall(world, 5, 0);
    wall(world, 8, 0);
    const hit = sphereCastWorld(world, { origin: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.5, maxDist: 100 })!;
    expect(hit.distance).toBeCloseTo(4, 3);
  });

  it("hits spheres too", () => {
    const world = new World();
    const e = world.create();
    world.add(e, "transform", makeTransform(4, 0, 0));
    world.add(e, "sphere", { radius: 1, isStatic: true });
    const hit = sphereCastWorld(world, { origin: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.5, maxDist: 100 })!;
    expect(hit.distance).toBeCloseTo(2.5, 3);
  });

  it("honours the ignore set and rejects degenerate directions", () => {
    const world = new World();
    const e = wall(world, 5, 0);
    const hit = sphereCastWorld(world, {
      origin: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.5, maxDist: 100, ignore: new Set([e]),
    });
    expect(hit).toBeNull();
    expect(sphereCastWorld(world, { origin: new Vec3(0, 0, 0), direction: new Vec3(0, 0, 0), radius: 1, maxDist: 10 })).toBeNull();
  });
});

describe("overlapSphereWorld", () => {
  it("finds overlapping bodies and skips ignored ones", () => {
    const world = new World();
    const a = wall(world, 1, 0);
    const b = wall(world, 20, 0);
    const hits = overlapSphereWorld(world, new Vec3(0, 0, 0), 1.2);
    expect(hits).toContain(a);
    expect(hits).not.toContain(b);
    expect(overlapSphereWorld(world, new Vec3(0, 0, 0), 1.2, new Set([a]))).not.toContain(a);
  });
});

describe("mesh colliders", () => {
  function triangleWorld() {
    const world = new World();
    const e = world.create();
    world.add(e, "transform", makeTransform(0, 0, 0));
    world.add(e, "meshCollider", {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 2]),
      indices: new Uint16Array([0, 1, 2]),
    });
    return { world, e };
  }

  it("hits the triangle from above", () => {
    const { world, e } = triangleWorld();
    const hit = raycastMeshes(world, { origin: new Vec3(0.2, 5, 0.2), direction: new Vec3(0, -1, 0), maxDist: 100 })!;
    expect(hit).not.toBeNull();
    expect(hit.entity).toBe(e);
    expect(hit.distance).toBeCloseTo(5, 3);
    expect(hit.triangle).toBe(0);
    expect(Math.abs(hit.normal.y)).toBeCloseTo(1, 3);
  });

  it("misses beside the triangle and respects maxDist", () => {
    const { world } = triangleWorld();
    expect(raycastMeshes(world, { origin: new Vec3(9, 5, 9), direction: new Vec3(0, -1, 0), maxDist: 100 })).toBeNull();
    expect(raycastMeshes(world, { origin: new Vec3(0.2, 5, 0.2), direction: new Vec3(0, -1, 0), maxDist: 1 })).toBeNull();
  });

  it("applies the entity transform", () => {
    const { world, e } = triangleWorld();
    world.get<Transform>(e, "transform")!.position.set(10, 0, 0);
    const hit = raycastMeshes(world, { origin: new Vec3(10.2, 5, 0.2), direction: new Vec3(0, -1, 0), maxDist: 100 })!;
    expect(hit).not.toBeNull();
    expect(raycastMeshes(world, { origin: new Vec3(0.2, 5, 0.2), direction: new Vec3(0, -1, 0), maxDist: 100 })).toBeNull();
  });

  it("ignores the caster", () => {
    const { world, e } = triangleWorld();
    const hit = raycastMeshes(world, {
      origin: new Vec3(0.2, 5, 0.2), direction: new Vec3(0, -1, 0), maxDist: 100, ignore: new Set([e]),
    });
    expect(hit).toBeNull();
  });
});

describe("compound colliders", () => {
  function plus() {
    const world = new World();
    const e = makeCompound(world, 0, 0, 0, [
      { offset: new Vec3(1.5, 0, 0), halfExtents: new Vec3(0.5, 0.5, 0.5), rotationY: 0 },
      { offset: new Vec3(-1.5, 0, 0), halfExtents: new Vec3(0.5, 0.5, 0.5), rotationY: 0 },
      { offset: new Vec3(0, 0, 1.5), halfExtents: new Vec3(0.5, 0.5, 0.5), rotationY: 0 },
    ]);
    return { world, e };
  }

  it("computes world bounds over all parts", () => {
    const { world, e } = plus();
    const b = compoundBounds(world, e)!;
    expect(b.min.x).toBeCloseTo(-2);
    expect(b.max.x).toBeCloseTo(2);
    expect(b.min.z).toBeCloseTo(-0.5);
    expect(b.max.z).toBeCloseTo(2);
  });

  it("casts against the nearest part and rotates normals", () => {
    const { world, e } = plus();
    const hit = sphereCastCompound(world, e, {
      origin: new Vec3(-10, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.25, maxDist: 100,
    })!;
    expect(hit).not.toBeNull();
    expect(hit.entity).toBe(e);
    expect(hit.distance).toBeCloseTo(7.75, 2); // -10 -> -2.0 (box face) - 0.25 radius
    expect(hit.normal.x).toBeCloseTo(-1, 2);
    expect(sphereCastCompound(world, e, { origin: new Vec3(0, 5, 0), direction: new Vec3(0, -1, 0), radius: 0.25, maxDist: 100 })).toBeNull();
  });

  it("returns null for a non-compound entity", () => {
    const world = new World();
    const b = wall(world);
    expect(compoundBounds(world, b)).toBeNull();
    expect(sphereCastCompound(world, b, { origin: new Vec3(0, 0, 0), direction: new Vec3(1, 0, 0), radius: 0.5, maxDist: 10 })).toBeNull();
  });

  it("rotates part offsets with the entity yaw", () => {
    const world = new World();
    const e = makeCompound(world, 0, 0, 0, [
      { offset: new Vec3(2, 0, 0), halfExtents: new Vec3(0.5, 0.5, 0.5), rotationY: 0 },
    ]);
    world.get<Transform>(e, "transform")!.rotationY = Math.PI / 2;
    const b = compoundBounds(world, e)!;
    // +X rotates toward -Z at +90 degrees, matching Mat4.rotateY.
    expect(b.min.z).toBeCloseTo(-2.5, 3);
    expect(b.max.z).toBeCloseTo(-1.5, 3);
    expect(Math.abs(b.max.x)).toBeCloseTo(0.5, 3);
  });
});

describe("contact collection", () => {
  it("reports overlapping dynamic bodies above the threshold", () => {
    const world = new World();
    const staticBox = wall(world, 0, 0);
    const a = world.create();
    world.add(a, "transform", makeTransform(0.2, 0, 0));
    world.add(a, "rigidbody", { velocity: new Vec3(1, 0, 0), useGravity: false, mass: 1, grounded: false });
    world.add(a, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    const contacts = collectContacts(world, { minImpulse: 0.5 });
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts.some((c) => c.a === a || c.b === a)).toBe(true);
    expect(contacts[0].impulse).toBeCloseTo(1);
    void staticBox;
  });

  it("filters by impulse and by the engine layer/mask rule", () => {
    const world = new World();
    const ground = wall(world, 0, 0);
    const a = world.create();
    world.add(a, "transform", makeTransform(0.2, 0, 0));
    world.add(a, "rigidbody", { velocity: new Vec3(0.1, 0, 0), useGravity: false, mass: 1, grounded: false });
    world.add(a, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    // Slow body, below the impulse threshold.
    expect(collectContacts(world, { minImpulse: 0.5 })).toHaveLength(0);
    expect(collectContacts(world, { minImpulse: 0.05 }).length).toBeGreaterThan(0);

    // Put the body on layer 3 and make the ground ignore it.
    setLayer(world, a, 3);
    setMask(world, ground, layerBit(0));
    expect(collectContacts(world, { minImpulse: 0.05 })).toHaveLength(0);
    // Opting out of layer filtering reports it anyway.
    expect(collectContacts(world, { minImpulse: 0.05, respectLayers: false }).length).toBeGreaterThan(0);
  });

  it("returns nothing for separated bodies", () => {
    const world = new World();
    const a = world.create();
    world.add(a, "transform", makeTransform(0, 0, 0));
    world.add(a, "rigidbody", { velocity: new Vec3(5, 0, 0), useGravity: false, mass: 1, grounded: false });
    world.add(a, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    expect(collectContacts(world)).toHaveLength(0);
  });
});
