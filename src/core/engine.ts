import { World } from "../ecs/world.js";
import { GameLoop } from "../core/loop.js";
import { Renderer } from "../rendering/renderer.js";
import { Physics } from "../physics/physics.js";
import { TriggerSystem } from "../physics/trigger.js";
import { Input } from "../input/input.js";
import { AudioEngine } from "../audio/audio.js";
import { FrameProfiler } from "../debug/profiler.js";

export class Engine {
  world = new World();
  renderer: Renderer;
  physics = new Physics();
  triggers = new TriggerSystem();
  input = new Input();
  audio = new AudioEngine();
  profiler = new FrameProfiler();
  loop: GameLoop;
  private systems: ((dt: number) => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.input.attach(canvas);
    this.loop = new GameLoop(
      (dt) => {
        this.profiler.scoped("systems", () => { for (const s of this.systems) s(dt); });
        this.profiler.scoped("physics", () => this.physics.step(this.world, dt));
        this.profiler.scoped("triggers", () => this.triggers.update(this.world));
        this.profiler.gauge("entities", this.world.count());
      },
      () => {
        this.profiler.scoped("render", () => this.renderer.frame(this.world));
        const st = this.renderer.stats;
        this.profiler.gauge("drawn", st.drawn);
        this.profiler.gauge("culled", st.culled);
        this.profiler.gauge("batches", st.instancedDraws);
        this.profiler.gauge("post", st.postDraws);
      },
      1 / 60,
      () => { this.input.endFrame(); this.profiler.frame(); }
    );
  }

  addSystem(fn: (dt: number) => void) {
    this.systems.push(fn);
  }

  start() {
    this.loop.start();
  }
}
