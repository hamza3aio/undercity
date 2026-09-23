// Glitch loading screen — staged boot with honest progress.
// Stages map to real init work; a minimum display time keeps it readable.

const TIPS = [
  "Buyers walk the streets at night — sell fair or haggle.",
  "Stashed cash survives Warden busts. Wallets don't.",
  "Deposits are capped at $10,000 — for everyone, always.",
  "Assign crew to Streets and they run product for a 20% cut.",
  "Heat cools faster during the day. Lay low after big sales.",
  "Blend batches at the warehouse bench for better margins.",
  "The Corner Board makes every foot chase winnable.",
];

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error("missing #" + id);
  return e;
}

export class LoadingScreen {
  private shownAt = 0;

  show(title: string) {
    this.shownAt = performance.now();
    el("loadtitle").textContent = title;
    el("loadtip").textContent = "Tip: " + TIPS[Math.floor(Math.random() * TIPS.length)];
    this.stage(0.02, "Starting…");
    el("loading").style.display = "flex";
  }

  stage(frac: number, label: string) {
    el("loadfill").style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
    el("loadlabel").textContent = label;
  }

  async hide(minMs = 1400) {
    this.stage(1, "Ready.");
    const wait = Math.max(0, minMs - (performance.now() - this.shownAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el("loading").style.display = "none";
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
