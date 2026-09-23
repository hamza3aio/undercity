import type { Rigidbody, Transform } from "../ecs/components.js";

export interface CharacterConfig {
  speed: number;
  jumpSpeed: number;
  acceleration: number;
}

export class CharacterController {
  constructor(private config: CharacterConfig = { speed: 6, jumpSpeed: 8, acceleration: 40 }) {}

  move(t: Transform, rb: Rigidbody, wishX: number, wishZ: number, jump: boolean, dt: number, onJump?: () => void) {
    const targetX = wishX * this.config.speed;
    const targetZ = wishZ * this.config.speed;
    const k = Math.min(1, this.config.acceleration * dt);
    rb.velocity.x += (targetX - rb.velocity.x) * k;
    rb.velocity.z += (targetZ - rb.velocity.z) * k;
    if (jump && rb.grounded) {
      rb.velocity.y = this.config.jumpSpeed;
      rb.grounded = false;
      onJump?.();
    }
  }
}
