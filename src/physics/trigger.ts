import { Vec3 } from "../math/vec3.js";
import { World, type Entity } from "../ecs/world.js";
import type { Transform } from "../ecs/components.js";

export interface TriggerVolume {
  halfExtents: Vec3;
  entered: boolean;
}

export function makeTrigger(hx: number, hy: number, hz: number): TriggerVolume {
  return { halfExtents: new Vec3(hx, hy, hz), entered: false };
}

export class TriggerSystem {
  onEnter: ((trigger: Entity, other: Entity) => void) | null = null;
  onExit: ((trigger: Entity, other: Entity) => void) | null = null;
  private inside = new Map<Entity, Set<Entity>>();

  update(world: World) {
    const triggers = world.query("transform", "trigger");
    const bodies = world.query("transform", "collider");
    for (const tr of triggers) {
      const tt = world.get<Transform>(tr, "transform")!;
      const tv = world.get<TriggerVolume>(tr, "trigger")! as TriggerVolume;
      let set = this.inside.get(tr);
      if (!set) { set = new Set(); this.inside.set(tr, set); }
      const nowInside = new Set<Entity>();
      for (const b of bodies) {
        if (b === tr) continue;
        const bt = world.get<Transform>(b, "transform")!;
        if (Math.abs(bt.position.x - tt.position.x) <= tv.halfExtents.x &&
            Math.abs(bt.position.y - tt.position.y) <= tv.halfExtents.y &&
            Math.abs(bt.position.z - tt.position.z) <= tv.halfExtents.z) {
          nowInside.add(b);
          if (!set.has(b)) this.onEnter?.(tr, b);
        }
      }
      for (const prev of [...set]) {
        if (!nowInside.has(prev)) this.onExit?.(tr, prev);
      }
      this.inside.set(tr, nowInside);
      tv.entered = nowInside.size > 0;
    }
  }
}
