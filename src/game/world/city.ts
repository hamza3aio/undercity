import { World, type Entity } from "../../ecs/world.js";
import { Vec3 } from "../../math/vec3.js";
import { makeTransform, type MeshRef } from "../../ecs/components.js";
import { DISTRICTS, PROPERTIES } from "../data/world.js";

export interface CityRefs {
  buildings: Entity[];
  propertyEntities: Record<string, Entity>;
  npcAvatars: Record<string, Entity>;
  beacons: Record<string, Entity>;
  truck: Entity;
  cratePile: Entity;
}

// Deterministic pseudo-random for stable city layout.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function addStaticBox(world: World, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: [number, number, number], textureId?: string): Entity {
  const e = world.create();
  const t = makeTransform(x, y, z);
  t.scale.set(sx, sy, sz);
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color, textureId });
  world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });
  world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: false, mass: 0, grounded: true });
  return e;
}

export function districtAt(x: number, z: number): string {
  for (const d of DISTRICTS) {
    if (Math.abs(x - d.center[0]) <= d.size / 2 && Math.abs(z - d.center[1]) <= d.size / 2) return d.name;
  }
  return "Streets";
}

export const PROPERTY_SPOTS: Record<string, [number, number]> = {
  office: [6, -8],
  garage: [-10, 4],
  warehouse: [8, 30],
  shop: [30, 2],
  factory: [34, -28],
  apartments: [-32, 12],
};

export const NPC_SPOTS: Record<string, [number, number]> = {
  bram: [-34, -26],
  vesper: [32, 8],
  odell: [10, 34],
  junie: [36, -30],
  ines: [-6, -32],
  corvin: [2, 2],
};

export function buildCity(world: World): CityRefs {
  // Ground
  const g = world.create();
  world.add(g, "transform", makeTransform(0, -0.51, 0));
  world.add<MeshRef>(g, "mesh", { meshId: "ground", color: [0.16, 0.18, 0.24], textureId: "checker", uvScale: 8 });
  world.add(g, "collider", { halfExtents: new Vec3(60, 0.5, 60), isStatic: true });

  // Roads: dark strips on a grid
  for (let i = -2; i <= 2; i++) {
    for (const horiz of [true, false]) {
      const e = world.create();
      const t = makeTransform(horiz ? 0 : i * 24, 0.02, horiz ? i * 24 : 0);
      t.scale.set(horiz ? 110 : 4, 0.05, horiz ? 4 : 110);
      world.add(e, "transform", t);
      world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [0.09, 0.1, 0.13] });
    }
  }

  // District buildings
  const buildings: Entity[] = [];
  const rand = rng(1337);
  for (const d of DISTRICTS) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const bx = d.center[0] + (rand() - 0.5) * (d.size - 6);
      const bz = d.center[1] + (rand() - 0.5) * (d.size - 6);
      if (Math.abs(bx) < 4 && Math.abs(bz) < 4) continue; // keep spawn plaza clear
      const h = 2 + d.wealth * 14 * rand() + rand() * 2;
      const w = 2.5 + rand() * 3;
      const shade = 0.75 + rand() * 0.5;
      buildings.push(addStaticBox(world, bx, h / 2, bz, w, h, w,
        [d.color[0] * shade, d.color[1] * shade, d.color[2] * shade],
        rand() > 0.5 ? "checker" : undefined));
    }
  }

  // Property plots: level 1 shack -> grows + brightens per level (visible upgrades)
  const propertyEntities: Record<string, Entity> = {};
  for (const p of PROPERTIES) {
    const spot = PROPERTY_SPOTS[p.id];
    if (!spot) continue;
    propertyEntities[p.id] = addStaticBox(world, spot[0], 0.5, spot[1], 3, 1, 3, [0.25, 0.25, 0.28]);
  }

  // NPC avatars (tall capsules approximated by stretched cubes + accent head)
  const npcAvatars: Record<string, Entity> = {};
  const palette: [number, number, number][] = [[0.8, 0.4, 0.3], [0.6, 0.4, 0.9], [0.3, 0.7, 0.6], [0.85, 0.7, 0.3], [0.4, 0.6, 0.9], [0.9, 0.3, 0.5]];
  let pi = 0;
  for (const [id, spot] of Object.entries(NPC_SPOTS)) {
    const c = palette[pi++ % palette.length];
    const e = addStaticBox(world, spot[0], 0.9, spot[1], 0.8, 1.8, 0.8, c);
    npcAvatars[id] = e;
  }

  // Work-site beacons (gold pillars, no collision)
  const beacons: Record<string, Entity> = {};
  const siteDefs: [string, number, number][] = [["siteA", 14, -12], ["siteB", -16, 22], ["siteC", 22, 20]];
  for (const [id, x, z] of siteDefs) {
    const e = world.create();
    const t = makeTransform(x, 2, z);
    t.scale.set(0.5, 4, 0.5);
    world.add(e, "transform", t);
    world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [1.0, 0.75, 0.2] });
    beacons[id] = e;
  }

  // Drivable work truck (dynamic body)
  const truck = world.create();
  {
    const t = makeTransform(-6, 0.8, 8);
    t.scale.set(1.4, 1.1, 2.6);
    world.add(truck, "transform", t);
    world.add<MeshRef>(truck, "mesh", { meshId: "cube", color: [0.85, 0.55, 0.15], textureId: "checker" });
    world.add(truck, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    world.add(truck, "rigidbody", { velocity: new Vec3(), useGravity: true, mass: 4, grounded: false });
  }

  // Crate pile at the warehouse (pickup point for deliveries)
  const cratePile = world.create();
  {
    const t = makeTransform(8, 0.5, 33);
    t.scale.set(1.2, 1, 1.2);
    world.add(cratePile, "transform", t);
    world.add<MeshRef>(cratePile, "mesh", { meshId: "cube", color: [0.6, 0.45, 0.25], textureId: "checker" });
  }

  return { buildings, propertyEntities, npcAvatars, beacons, truck, cratePile };
}

// Sync property visuals with sim levels: unowned = grey shack, Lv1..3 grow + take property color.
export function syncPropertyVisuals(world: World, refs: CityRefs, levels: Record<string, number>) {
  for (const p of PROPERTIES) {
    const e = refs.propertyEntities[p.id];
    if (e === undefined) continue;
    const t = world.get<{ position: Vec3; rotationY: number; scale: Vec3 }>(e, "transform");
    const m = world.get<MeshRef>(e, "mesh");
    if (!t || !m) continue;
    const lv = levels[p.id] ?? 0;
    if (lv === 0) {
      t.scale.set(3, 1, 3);
      t.position.y = 0.5;
      m.color = [0.25, 0.25, 0.28];
      m.textureId = undefined;
    } else {
      const s = 3 + lv * 1.6;
      const h = 1.5 + lv * 1.8;
      t.scale.set(s, h, s);
      t.position.y = h / 2;
      const k = 0.7 + lv * 0.15;
      m.color = [Math.min(1, p.color[0] * k), Math.min(1, p.color[1] * k), Math.min(1, p.color[2] * k)];
      m.textureId = "checker";
    }
  }
}
