import { Vec3 } from "../math/vec3.js";

export interface DirectionalLight {
  direction: Vec3;
  intensity: number;
}

export interface PointLight {
  position: Vec3;
  color: [number, number, number];
  intensity: number;
  range: number;
}

export const MAX_POINT_LIGHTS = 4;

export function makeDirectional(direction = new Vec3(-0.5, -1, -0.3), intensity = 1): DirectionalLight {
  return { direction, intensity };
}
