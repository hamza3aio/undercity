import { World, type Entity } from "../../ecs/world.js";
import { Vec3 } from "../../math/vec3.js";
import { makeTransform, type MeshRef } from "../../ecs/components.js";
import { DISTRICTS, PROPERTIES } from "../data/world.js";
import { box, car, cone, dashes, dumpster, fenceRun, gasStation, house, mailbox, mountains, pier, pine, shop, sidewalk, siteFrame, wireRun } from "./citykit.js";

export interface CityRefs {
  buildings: Entity[];
  propertyEntities: Record<string, Entity>;
  beacons: Record<string, Entity>;
  truck: Entity;
  cratePile: Entity;
  bench: Entity;
  lamps: Entity[];
  sun: Entity;
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

function addVisual(world: World, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: [number, number, number]): Entity {
  const e = world.create();
  const t = makeTransform(x, y, z);
  t.scale.set(sx, sy, sz);
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color });
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
  junie: [27, -27],
  ines: [-6, -32],
  corvin: [2, 2],
};

export function buildCity(world: World): CityRefs {
  // Ground (140 wide, tiled)
  const g = world.create();
  world.add(g, "transform", makeTransform(0, -0.51, 0));
  world.add<MeshRef>(g, "mesh", { meshId: "ground", color: [0.16, 0.18, 0.24], textureId: "checker", uvScale: 1 });
  world.add(g, "collider", { halfExtents: new Vec3(70, 0.5, 70), isStatic: true });

  // Roads: dark strips on a grid + dashes + sidewalks on the two main roads
  for (let i = -2; i <= 2; i++) {
    for (const horiz of [true, false]) {
      const e = world.create();
      const t = makeTransform(horiz ? 0 : i * 24, 0.02, horiz ? i * 24 : 0);
      t.scale.set(horiz ? 140 : 4, 0.05, horiz ? 4 : 140);
      world.add(e, "transform", t);
      world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [0.09, 0.1, 0.13] });
    }
  }
  dashes(world, 0, -54, 54, false);
  dashes(world, 0, -54, 54, true);
  sidewalk(world, -3.5, 0, 2, 140);
  sidewalk(world, 3.5, 0, 2, 140);
  sidewalk(world, 0, -3.5, 140, 2);
  sidewalk(world, 0, 3.5, 140, 2);

  // District backdrop buildings (fewer now — kit pieces carry the detail)
  const buildings: Entity[] = [];
  const rand = rng(1337);
  for (const d of DISTRICTS) {
    for (let i = 0; i < 5; i++) {
      const bx = d.center[0] + (rand() - 0.5) * (d.size - 6);
      const bz = d.center[1] + (rand() - 0.5) * (d.size - 6);
      if (Math.abs(bx) < 5 && Math.abs(bz) < 9) continue; // keep spawn plaza clear
      const h = 2 + d.wealth * 14 * rand() + rand() * 2;
      const w = 2.5 + rand() * 3;
      const shade = 0.75 + rand() * 0.5;
      buildings.push(addStaticBox(world, bx, h / 2, bz, w, h, w,
        [d.color[0] * shade, d.color[1] * shade, d.color[2] * shade],
        rand() > 0.5 ? "checker" : undefined));
    }
  }

  // ---- Cinder Park suburb: houses, yards, pines, parked car ----
  house(world, -32, 2, 6, 7, 3, [0.55, 0.5, 0.42], [0.35, 0.22, 0.16]);
  fenceRun(world, -36.5, -2.5, -27.5, -2.5);
  pine(world, -38, 6, 1.1);
  pine(world, -27, 10, 0.9);
  mailbox(world, -28.5, -1.5);
  house(world, -41, 12, 5.5, 6, 2.8, [0.5, 0.46, 0.4], [0.3, 0.3, 0.34]);
  pine(world, -36, 16, 1.0);
  car(world, -28, 6, 1.57, [0.7, 0.2, 0.15]);
  house(world, -33, 20, 6, 6.5, 3, [0.48, 0.44, 0.38], [0.32, 0.2, 0.14]);
  mailbox(world, -29.5, 17);

  // ---- Hightown: two nicer houses ----
  house(world, -11, -33, 7, 7, 3.2, [0.72, 0.68, 0.6], [0.4, 0.25, 0.18]);
  fenceRun(world, -15.5, -28.5, -6.5, -28.5);
  pine(world, -15, -38, 1.2);
  house(world, 0, -41, 6.5, 7, 3, [0.6, 0.42, 0.35], [0.3, 0.3, 0.32]);
  pine(world, 5, -35, 1.0);
  mailbox(world, -7, -29);

  // ---- Mercer Row commercial: shops + gas station ----
  shop(world, 39, 13, 8, 4.5, 6, [0.55, 0.5, 0.44], [1.0, 0.72, 0.2]);
  shop(world, 40, -1, 7, 4, 6, [0.5, 0.46, 0.42], [0.85, 0.2, 0.15]);
  gasStation(world, 28, -13, [0.9, 0.45, 0.1]);
  cone(world, 24, -10);
  cone(world, 32, -10);
  dumpster(world, 44, 6);

  // ---- The Core: corner shops + parked cars ----
  shop(world, -9, -11, 9, 6, 7, [0.45, 0.47, 0.52], [0.25, 0.6, 0.9]);
  car(world, -4, -15, 0, [0.15, 0.2, 0.3]);
  car(world, 6, 12, 3.14, [0.5, 0.5, 0.55]);

  // ---- Old Docks waterfront: bay + pier + clutter ----
  {
    const w = world.create();
    const wt = makeTransform(44, 0.06, 50);
    wt.scale.set(0.32, 1, 0.3);
    world.add(w, "transform", wt);
    world.add<MeshRef>(w, "mesh", { meshId: "ground", color: [0.16, 0.3, 0.42] });
  }
  pier(world, 22, 46, 40);
  dumpster(world, 4, 36);
  dumpster(world, 16, 40);
  box(world, 20, 0.6, 38, 2.4, 1.2, 1.6, [0.45, 0.35, 0.22], { solid: true });

  // ---- Foundry Gate construction site ----
  fenceRun(world, 40, -40, 48, -40, 1.8, [0.6, 0.6, 0.62]);
  fenceRun(world, 48, -40, 48, -30, 1.8, [0.6, 0.6, 0.62]);
  fenceRun(world, 48, -30, 40, -30, 1.8, [0.6, 0.6, 0.62]);
  fenceRun(world, 40, -30, 40, -40, 1.8, [0.6, 0.6, 0.62]);
  siteFrame(world, 44, -35, 6, 5, 6);
  cone(world, 39, -31);
  box(world, 46, 0.75, -31.5, 2.5, 1.5, 1.5, [0.5, 0.38, 0.25], { solid: true });

  // ---- Rust Flats shacks ----
  house(world, -40, -28, 4.5, 5, 2.5, [0.42, 0.36, 0.3], [0.28, 0.2, 0.16]);
  house(world, -32, -34, 4, 4.5, 2.4, [0.4, 0.34, 0.28], [0.26, 0.2, 0.15]);
  pine(world, -44, -24, 1.0);
  pine(world, -29, -22, 0.8);

  // ---- Power lines along two roads ----
  wireRun(world, 22.5, -48, 22.5, 48);
  wireRun(world, -48, 26.5, 48, 26.5);

  // ---- Distant mountains ----
  mountains(world);

  // Property plots: level 1 shack -> grows + brightens per level (visible upgrades)
  const propertyEntities: Record<string, Entity> = {};
  for (const p of PROPERTIES) {
    const spot = PROPERTY_SPOTS[p.id];
    if (!spot) continue;
    propertyEntities[p.id] = addStaticBox(world, spot[0], 0.5, spot[1], 3, 1, 3, [0.25, 0.25, 0.28]);
  }

  // NPC talk spots live in NPC_SPOTS (game builds cartoon rigs for them).

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

  // Crate pile near the warehouse (pickup point for deliveries)
  const cratePile = world.create();
  {
    const t = makeTransform(14, 0.5, 33);
    t.scale.set(1.2, 1, 1.2);
    world.add(cratePile, "transform", t);
    world.add<MeshRef>(cratePile, "mesh", { meshId: "cube", color: [0.6, 0.45, 0.25], textureId: "checker" });
  }

  // Mixing bench near the warehouse
  const bench = addVisual(world, 14, 0.5, 27, 2.2, 1, 1.2, [0.5, 0.32, 0.2]);

  // Lamp posts around the plaza + warehouse (poles; light comes from renderer)
  const lamps: Entity[] = [];
  for (const [lx, lz] of [[-8, -4], [8, -4], [-8, 12], [8, 12], [8, 27]] as [number, number][]) {
    addStaticBox(world, lx, 1.5, lz, 0.25, 3, 0.25, [0.12, 0.12, 0.15]);
    lamps.push(addVisual(world, lx, 3.1, lz, 0.6, 0.3, 0.6, [1.0, 0.85, 0.55]));
  }

  // Sun / moon disc (repositioned + recolored by time of day)
  const sun = addVisual(world, 0, 40, -100, 10, 10, 1, [1.0, 0.8, 0.5]);

  // Lit windows on backdrop buildings (night-city feel, always on)
  {
    const wrand = rng(777);
    for (const b of buildings) {
      if (wrand() < 0.55) continue;
      const bt = world.get<ReturnType<typeof makeTransform>>(b, "transform");
      if (!bt) continue;
      const nw = 1 + Math.floor(wrand() * 3);
      for (let i = 0; i < nw; i++) {
        addVisual(world,
          bt.position.x + (wrand() - 0.5) * bt.scale.x,
          bt.position.y + (wrand() - 0.5) * bt.scale.y * 0.7,
          bt.position.z + bt.scale.z * 0.52,
          0.5, 0.7, 0.1, [1.0, 0.8, 0.45]);
      }
    }
  }

  return { buildings, propertyEntities, beacons, truck, cratePile, bench, lamps, sun };
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
