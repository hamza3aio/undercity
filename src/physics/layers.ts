// Glitch collision layers — 32-bit layer/mask filtering.
// Convention: component "layer" = { layer: 0..31 } (default 0),
// component "mask" = { mask: bitfield } (default all bits).
// Two bodies interact iff each one's mask contains the other's layer:
//   (maskA & (1 << layerB)) !== 0 && (maskB & (1 << layerA)) !== 0
// Entities without the components behave exactly as before (layer 0, all).

import { World, type Entity } from "../ecs/world.js";

export const LAYER_COMPONENT = "layer";
export const MASK_COMPONENT = "mask";
export const DEFAULT_LAYER = 0;
export const ALL_MASK = 0xffffffff;

export interface Layer {
  layer: number;
}

export interface CollideMask {
  mask: number;
}

export function layerBit(n: number): number {
  return (1 << (n & 31)) >>> 0;
}

export function setLayer(world: World, e: Entity, layer: number): void {
  if (!world.isAlive(e)) throw new Error(`setLayer: entity #${e} is not alive`);
  if (!Number.isInteger(layer) || layer < 0 || layer > 31) {
    throw new Error(`setLayer: layer must be an integer 0..31 (got ${layer})`);
  }
  world.add<Layer>(e, LAYER_COMPONENT, { layer });
}

export function getLayer(world: World, e: Entity): number {
  return world.get<Layer>(e, LAYER_COMPONENT)?.layer ?? DEFAULT_LAYER;
}

export function setMask(world: World, e: Entity, mask: number): void {
  if (!world.isAlive(e)) throw new Error(`setMask: entity #${e} is not alive`);
  world.add<CollideMask>(e, MASK_COMPONENT, { mask: mask >>> 0 });
}

export function getMask(world: World, e: Entity): number {
  return world.get<CollideMask>(e, MASK_COMPONENT)?.mask ?? ALL_MASK;
}

export function layersCollide(world: World, a: Entity, b: Entity): boolean {
  const la = getLayer(world, a);
  const lb = getLayer(world, b);
  return (
    (getMask(world, a) & layerBit(lb)) !== 0 &&
    (getMask(world, b) & layerBit(la)) !== 0
  );
}
