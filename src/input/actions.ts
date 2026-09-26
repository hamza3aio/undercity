import type { Input } from "../input/input.js";
import { ActionMap } from "./actionmap.js";

// Legacy WASD/Space/R helper, now delegated to an ActionMap with identical
// keyboard behavior. For gamepad edges, call update() once per frame.
export class InputActions {
  private map: ActionMap;

  constructor(input: Input) {
    this.map = new ActionMap(input);
    this.map.defineVector("move", {
      left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
      up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"],
    });
    this.map.defineButton("jump", { keys: ["Space"] });
    this.map.defineButton("reset", { keys: ["KeyR"] });
  }

  update(): void {
    this.map.update();
  }

  move(): { x: number; z: number } {
    const v = this.map.vector("move");
    return { x: v.x, z: v.y };
  }

  jump(): boolean {
    return this.map.down("jump");
  }

  reset(): boolean {
    return this.map.down("reset");
  }
}
