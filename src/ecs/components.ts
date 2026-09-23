import { Vec3 } from "../math/vec3.js";

export interface Transform {
  position: Vec3;
  rotationY: number;
  scale: Vec3;
}

export function makeTransform(x = 0, y = 0, z = 0): Transform {
  return { position: new Vec3(x, y, z), rotationY: 0, scale: new Vec3(1, 1, 1) };
}

export interface Rigidbody {
  velocity: Vec3;
  useGravity: boolean;
  mass: number;
  grounded: boolean;
}

export function makeRigidbody(useGravity = true, mass = 1): Rigidbody {
  return { velocity: new Vec3(), useGravity, mass, grounded: false };
}

export interface BoxCollider {
  halfExtents: Vec3; // local half size (before scale)
  isStatic: boolean;
}

export interface MeshRef {
  meshId: string;
  color: [number, number, number];
  textureId?: string;
  uvScale?: number;
  shininess?: number;
}

export interface Spin {
  speed: number;
}

export interface PlayerTag {
  speed: number;
  jumpSpeed: number;
}
