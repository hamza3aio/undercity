import { World } from "../ecs/world.js";
import type { Transform } from "../ecs/components.js";
import { saveScene, loadScene } from "../scene/scene.js";

// Minimal DOM editor: hierarchy list + selected transform inspector + save/load + pause.
export class EditorOverlay {
  private panel: HTMLElement;
  private listEl: HTMLElement;
  private infoEl: HTMLElement;
  private paused = false;
  selected = -1;

  constructor(private world: World, private root: HTMLElement) {
    this.panel = document.createElement("div");
    this.panel.style.cssText = "position:absolute;top:60px;right:12px;width:230px;max-height:70vh;overflow:auto;background:rgba(10,14,22,0.85);border:1px solid #334155;border-radius:8px;padding:10px;font-size:12px;";
    this.panel.innerHTML = "<strong>Glitch Editor</strong>";
    this.listEl = document.createElement("div");
    this.infoEl = document.createElement("div");
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:6px;margin:8px 0;";
    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "flex:1;padding:4px;background:#1e293b;color:#fff;border:1px solid #475569;border-radius:4px;cursor:pointer;";
      b.onclick = fn;
      btnRow.appendChild(b);
    };
    mkBtn(this.paused ? "Play" : "Pause", () => { this.paused = !this.paused; });
    mkBtn("Save", () => {
      const json = saveScene(this.world);
      void navigator.clipboard?.writeText(json).catch(() => undefined);
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "glitch-scene.json";
      a.click();
    });
    mkBtn("Load", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) return;
        void f.text().then((t) => loadScene(this.world, t));
      };
      input.click();
    });
    this.panel.appendChild(btnRow);
    this.panel.appendChild(this.listEl);
    this.panel.appendChild(this.infoEl);
    root.appendChild(this.panel);
  }

  isPaused() { return this.paused; }

  update() {
    const entities = this.world.query("transform");
    this.listEl.innerHTML = `<div style="opacity:0.7;margin:4px 0;">${entities.length} entities (click to inspect)</div>`;
    for (const e of entities.slice(0, 60)) {
      const b = document.createElement("button");
      b.textContent = `#${e}`;
      b.style.cssText = `margin:2px;padding:2px 6px;background:${e === this.selected ? "#3b82f6" : "#0f172a"};color:#fff;border:1px solid #334155;border-radius:4px;cursor:pointer;`;
      b.onclick = () => { this.selected = e; this.renderInspector(); };
      this.listEl.appendChild(b);
    }
    this.renderInspector();
  }

  private renderInspector() {
    if (this.selected < 0) { this.infoEl.innerHTML = "<div style='opacity:0.6'>No selection</div>"; return; }
    const t = this.world.get<Transform>(this.selected, "transform");
    if (!t) { this.infoEl.innerHTML = "<div>Entity removed</div>"; return; }
    this.infoEl.innerHTML =
      `<div style="margin-top:8px;border-top:1px solid #334155;padding-top:6px;">` +
      `<div>Entity #${this.selected}</div>` +
      `<div>pos ${t.position.x.toFixed(2)}, ${t.position.y.toFixed(2)}, ${t.position.z.toFixed(2)}</div>` +
      `<div>rotY ${t.rotationY.toFixed(2)} scale ${t.scale.x.toFixed(2)}</div></div>`;
  }
}
