import { Time } from "./time.js";

export type UpdateFn = (dt: number, time: Time) => void;

export class GameLoop {
  time = new Time();
  private raf = 0;
  private running = false;
  private accumulator = 0;
  fixedStep: number; // e.g. 1/60 for physics

  constructor(
    private update: UpdateFn,
    private render: () => void,
    fixedStep = 1 / 60,
    private frameEnd?: () => void
  ) {
    this.fixedStep = fixedStep;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.time.reset(performance.now());
    const frame = (now: number) => {
      if (!this.running) return;
      this.time.tick(now);
      this.accumulator += this.time.delta;
      let steps = 0;
      while (this.accumulator >= this.fixedStep && steps < 4) {
        this.update(this.fixedStep, this.time);
        this.accumulator -= this.fixedStep;
        steps++;
      }
      if (steps === 4) this.accumulator = 0; // avoid spiral of death
      this.render();
      this.frameEnd?.();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
