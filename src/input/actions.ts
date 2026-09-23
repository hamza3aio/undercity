import type { Input } from "../input/input.js";

export class InputActions {
  constructor(private input: Input) {}

  move(): { x: number; z: number } {
    const fwd = this.input.axis("KeyS", "KeyW") + this.input.axis("ArrowDown", "ArrowUp");
    const strafe = this.input.axis("KeyA", "KeyD") + this.input.axis("ArrowLeft", "ArrowRight");
    return { x: Math.max(-1, Math.min(1, strafe)), z: Math.max(-1, Math.min(1, fwd)) };
  }

  jump(): boolean {
    return this.input.down("Space");
  }

  reset(): boolean {
    return this.input.down("KeyR");
  }
}
