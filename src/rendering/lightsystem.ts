// Glitch light sources — binds ECS Light components to the renderer's
// upload slots. Systems call sync() once per frame; the renderer then ranks
// the resulting array (rankLights in lights.ts) so the most relevant lights
// win the 4 slots. Spot aims are stored in local space, so rotating the
// entity aims the light (lights can be parented and animated).

import { World, type Entity } from "../ecs/world.js";
import { Vec3 } from "../math/vec3.js";
import { makeLight, makeTransform, type Light, type Transform } from "../ecs/components.js";
import type { Renderer } from "../rendering/renderer.js";
import { sanitizeSpot, type PointLight, type SpotLight } from "../rendering/lights.js";

/** Rotates a local direction by a yaw-only transform. */
export function rotateY(v: [number, number, number], yaw: number, out = new Vec3()): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return out.set(v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c);
}

export interface LightSyncResult {
  points: number;
  spots: number;
  culled: number; // lights that were off or zero-intensity
}

export class LightSystem {
  /** Creates a light entity at a world position. */
  addLight(kind: "point" | "spot", x: number, y: number, z: number, partial: Partial<Light> = {}): Entity {
    const e = this.world.create();
    this.world.add(e, "transform", makeTransform(x, y, z));
    this.world.add(e, "light", { ...makeLight(kind), ...partial });
    return e;
  }

  /** Rebuilds the renderer's light arrays from the world's Light components. */
  sync(): LightSyncResult {
    const pts: PointLight[] = [];
    const sps: SpotLight[] = [];
    let culled = 0;
    for (const e of this.world.query("transform", "light") as Entity[]) {
      const l = this.world.get<Light>(e, "light")!;
      const t = this.world.get<Transform>(e, "transform")!;
      if (!l.on || !(l.intensity > 0)) {
        culled++;
        continue;
      }
      if (l.kind === "spot") {
        sps.push(sanitizeSpot({
          position: t.position,
          direction: rotateY(l.direction, t.rotationY),
          color: l.color,
          intensity: l.intensity,
          range: l.range,
          innerAngle: l.innerAngle,
          outerAngle: l.outerAngle,
        }));
      } else {
        pts.push({ position: t.position, color: l.color, intensity: l.intensity, range: l.range });
      }
    }
    this.renderer.pointLights = pts;
    this.renderer.spotLights = sps;
    return { points: pts.length, spots: sps.length, culled };
  }

  constructor(private world: World, private renderer: Renderer) {}
}
