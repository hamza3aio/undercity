import { World } from "../ecs/world.js";
import { GameLoop } from "../core/loop.js";
import { Renderer } from "../rendering/renderer.js";
import { Physics } from "../physics/physics.js";
import { TriggerSystem } from "../physics/trigger.js";
import { Input } from "../input/input.js";
import { AudioEngine } from "../audio/audio.js";
import { FrameProfiler } from "../debug/profiler.js";
import { AssetDB } from "../assets/db.js";
import { QualitySettings } from "./quality.js";
import { Logger } from "../debug/logger.js";
import { PluginHost } from "../plugins/host.js";
import { ImportPipeline } from "../assets/pipeline.js";
import { createBuildSettingsService } from "./buildservice.js";

export class Engine {
  world = new World();
  renderer: Renderer;
  physics = new Physics();
  triggers = new TriggerSystem();
  input = new Input();
  audio = new AudioEngine();
  profiler = new FrameProfiler();
  assets = new AssetDB();
  /** Player-facing graphics configuration (loaded from localStorage). */
  quality = QualitySettings.load();
  /** Central log + error sink (Phase 19). */
  log = new Logger({ mirror: false });
  /** Import queue for OBJ / glTF / GLB (Phase 7). */
  imports = new ImportPipeline({ db: this.assets, log: this.log });
  /** Plugin host (Phase 22): systems/importers/panels from extensions. */
  plugins = new PluginHost({ onError: (name, err) => {
    this.log.error("plugins", `"${name}" failed`, undefined, err);
  } });
  /** Per-project packaging settings (Phase 20). */
  build = createBuildSettingsService();
  loop: GameLoop;
  private systems: ((dt: number) => void)[] = [];
  private systemNames: string[] = [];
  private lastSystemError = -1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.input.attach(canvas);
    // Quality drives resolution scale, shadow/post state and frame pacing.
    this.renderer.applyQuality(this.quality);
    this.loop = new GameLoop(
      (dt) => {
        this.profiler.scoped("systems", () => {
          for (let i = 0; i < this.systems.length; i++) {
            // A throwing game system must not kill the frame; it is reported
            // once per second so the cause stays visible.
            try {
              this.systems[i](dt);
            } catch (err) {
              const now = this.loop.time.elapsed;
              if (now - this.lastSystemError > 1) {
                this.lastSystemError = now;
                this.log.error(this.systemNames[i] ?? "systems", "system callback threw (continuing)", undefined, err);
              }
            }
          }
        });
        this.profiler.scoped("physics", () => this.physics.step(this.world, dt));
        this.profiler.scoped("triggers", () => this.triggers.update(this.world));
        this.profiler.scoped("plugins", () => { this.plugins.update(dt, this.world); });
        this.profiler.scoped("imports", () => { this.imports.pump(2); });
        this.profiler.gauge("entities", this.world.count());
      },
      () => {
        // Re-applied every frame so a settings change needs no restart.
        this.profiler.scoped("quality", () => this.renderer.applyQuality(this.quality));
        this.profiler.scoped("render", () => this.renderer.frame(this.world));
        const st = this.renderer.stats;
        this.profiler.gauge("drawn", st.drawn);
        this.profiler.gauge("culled", st.culled);
        this.profiler.gauge("batches", st.instancedDraws);
        this.profiler.gauge("post", st.postDraws);
      },
      1 / 60,
      () => {
        this.input.endFrame();
        this.loop.minFrameMs = this.quality.fpsLimitMs;
        this.profiler.frame();
      }
    );
  }

  addSystem(fn: (dt: number) => void, name = "system") {
    this.systems.push(fn);
    this.systemNames.push(name);
  }

  start() {
    this.loop.start();
  }
}
