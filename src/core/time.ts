export class Time {
  delta = 0; // seconds since last frame (clamped)
  elapsed = 0; // total seconds since start
  fps = 0;
  private last = -1;
  private frames = 0;
  private fpsTime = 0;

  reset(now: number) {
    this.last = now;
    this.delta = 0;
    this.elapsed = 0;
  }

  tick(nowMs: number) {
    if (this.last < 0) this.last = nowMs;
    const now = nowMs / 1000;
    const last = this.last / 1000;
    let dt = now - last;
    this.last = nowMs;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1; // clamp tab-switch spikes
    this.delta = dt;
    this.elapsed += dt;
    this.frames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTime);
      this.frames = 0;
      this.fpsTime = 0;
    }
  }
}
