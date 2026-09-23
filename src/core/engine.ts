import { World } from "../ecs/world.js";
import { GameLoop } from "../core/loop.js";
import { Renderer } from "../rendering/renderer.js";
import { Physics } from "../physics/physics.js";
import { TriggerSystem } from "../physics/trigger.js";
import { Input } from "../input/input.js";
import { AudioEngine } from "../audio/audio.js";

export class Engine {
  world = new World();
  renderer: Renderer;
  physics = new Physics();
  triggers = new TriggerSystem();
  input = new Input();
  audio = new AudioEngine();
  loop: GameLoop;
  private systems: ((dt: number) => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.input.attach(canvas);
    this.loop = new GameLoop(
      (dt) => {
        for (const s of this.systems) s(dt);
        this.physics.step(this.world, dt);
        this.triggers.update(this.world);
      },
      () => this.renderer.frame(this.world)
    );
  }

  addSystem(fn: (dt: number) => void) {
    this.systems.push(fn);
  }

  start() {
    this.loop.start();
  }
}
