export class HUD {
  private msgEl: HTMLElement | null = null;
  private msgTimer = 0;

  constructor(private statsEl: HTMLElement) {}

  attachMessage(el: HTMLElement) {
    this.msgEl = el;
  }

  setStats(text: string) {
    this.statsEl.textContent = text;
  }

  showMessage(text: string, seconds = 2) {
    if (!this.msgEl) return;
    this.msgEl.textContent = text;
    this.msgEl.style.display = "block";
    this.msgTimer = seconds;
  }

  update(dt: number) {
    if (this.msgTimer > 0 && this.msgEl) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msgEl.style.display = "none";
    }
  }
}
