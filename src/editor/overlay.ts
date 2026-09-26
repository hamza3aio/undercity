import { World, type Entity } from "../ecs/world.js";
import { Vec3 } from "../math/vec3.js";
import { Mat4 } from "../math/mat4.js";
import { makeTransform, type MeshRef, type Transform } from "../ecs/components.js";
import { setParent } from "../ecs/hierarchy.js";
import { saveScene, loadScene } from "../scene/scene.js";
import { buildActor, poseActor, type ActorOpts } from "../scene/actor.js";
import type { MaterialDB } from "../rendering/materials.js";
import type { ParticleSystem } from "../fx/particles.js";
import { fountainDef } from "../fx/particles.js";
import { History } from "./history.js";
import {
  axisParam, distPointToSegment2D, screenRay, snapValue, viewProj, worldToScreen,
} from "./gizmo.js";
import { raycastScene } from "../physics/raycast.js";

export interface Viewport {
  view: Mat4;
  proj: Mat4;
  width: number;
  height: number;
}

export interface EditorHooks {
  addTex: (id: string, img: TexImageSource) => void;
  projectPath?: () => string | null;
  mats?: MaterialDB;
  viewport?: () => Viewport | null;
  fx?: () => ParticleSystem | null;
}

interface CompSnap {
  name: string;
  data: unknown;
}

interface EntSnap {
  oldId: Entity;
  comps: CompSnap[];
}

// Snapshot one entity into plain JSON-safe data (Vec3s become arrays).
function snapEntity(world: World, e: Entity): EntSnap {
  const comps: CompSnap[] = [];
  const take = (name: string) => {
    const c = world.get<unknown>(e, name);
    if (c !== undefined) comps.push({ name, data: JSON.parse(JSON.stringify(c)) as unknown });
  };
  take("transform");
  take("mesh");
  take("collider");
  take("rigidbody");
  take("trigger");
  take("sphere");
  take("capsule");
  take("layer");
  take("mask");
  take("uid");
  take("parent");
  take("actor");
  take("actorPart");
  return { oldId: e, comps };
}

function reviveTransform(d: unknown): Transform {
  const v = d as { position: { x: number; y: number; z: number }; rotationY: number; scale: { x: number; y: number; z: number } };
  return {
    position: new Vec3(v.position.x, v.position.y, v.position.z),
    rotationY: v.rotationY,
    scale: new Vec3(v.scale.x, v.scale.y, v.scale.z),
  };
}

function reviveVec3(d: unknown): Vec3 {
  const v = d as { x: number; y: number; z: number };
  return new Vec3(v.x, v.y, v.z);
}

// Restore snapshots as NEW entities; returns oldId -> new Entity map and
// re-links in-snapshot parents (numeric ids are never reused by World).
function restoreSnap(world: World, snaps: EntSnap[]): Map<Entity, Entity> {
  const map = new Map<Entity, Entity>();
  for (const s of snaps) {
    const e = world.create();
    map.set(s.oldId, e);
    for (const c of s.comps) {
      if (c.name === "parent" || c.name === "actorPart") continue; // linked below / marker only
      if (c.name === "transform") world.add(e, "transform", reviveTransform(c.data));
      else if (c.name === "collider") {
        const d = c.data as { halfExtents: { x: number; y: number; z: number }; isStatic: boolean };
        world.add(e, "collider", { halfExtents: reviveVec3(d.halfExtents), isStatic: d.isStatic });
      } else if (c.name === "rigidbody") {
        const d = c.data as { velocity: { x: number; y: number; z: number }; useGravity: boolean; mass: number; grounded: boolean };
        world.add(e, "rigidbody", { velocity: reviveVec3(d.velocity), useGravity: d.useGravity, mass: d.mass, grounded: d.grounded });
      } else if (c.name === "trigger") {
        const d = c.data as { halfExtents: { x: number; y: number; z: number } };
        world.add(e, "trigger", { halfExtents: reviveVec3(d.halfExtents), entered: false });
      } else if (c.name === "sphere" || c.name === "capsule" || c.name === "layer" ||
        c.name === "mask" || c.name === "uid" || c.name === "mesh" || c.name === "actor") {
        world.add(e, c.name, JSON.parse(JSON.stringify(c.data)) as never);
      }
    }
  }
  // Re-link parents: in-snapshot via map, otherwise keep live external parent.
  for (const s of snaps) {
    const e = map.get(s.oldId);
    if (e === undefined) continue;
    const p = s.comps.find((c) => c.name === "parent");
    if (!p) continue;
    const oldParent = (p.data as { parent: Entity | null }).parent;
    if (oldParent === null || oldParent === undefined) continue;
    const target = map.get(oldParent) ?? (world.isAlive(oldParent) ? oldParent : null);
    if (target !== null) {
      try {
        setParent(world, e, target);
      } catch { /* malformed link: leave unparented */ }
    }
  }
  return map;
}

// Full in-engine editor: hierarchy + transform/color/material inspector,
// add box / static / trigger / actor, delete, undo/redo, move gizmo with
// snapping, click-to-select picking, play-pause, scene save/load.
// Save goes to the open project folder when hosted in the Glitch app,
// otherwise downloads JSON (plain browsers).
export class EditorOverlay {
  private panel: HTMLElement;
  private listEl: HTMLElement;
  private infoEl: HTMLElement;
  private undoBtn!: HTMLElement;
  private redoBtn!: HTMLElement;
  private snapBtn!: HTMLElement;
  private gizmoSvg: SVGSVGElement;
  private paused = false;
  private history = new History(100);
  private snapOn = true;
  private snapSize = 0.5;
  private drag: {
    axis: Vec3; startAxisT: number; startPos: Vec3; before: { pos: [number, number, number] };
  } | null = null;
  private downAt: { x: number; y: number } | null = null;
  selected = -1;
  private actorSeq = 0;

  constructor(private world: World, private root: HTMLElement, private hooks?: EditorHooks) {
    this.panel = document.createElement("div");
    this.panel.style.cssText = "position:absolute;top:60px;right:12px;width:270px;max-height:78vh;overflow:auto;background:rgba(10,14,22,0.9);border:1px solid #2dd4bf;border-radius:8px;padding:10px;font-size:12px;z-index:20;";
    this.panel.innerHTML = "<strong>Glitch Editor</strong> <span style='opacity:0.6'>(F9)</span>";
    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "flex:1;padding:4px;background:#1e293b;color:#fff;border:1px solid #475569;border-radius:4px;cursor:pointer;";
      b.onclick = fn;
      return b;
    };
    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex;gap:6px;margin:8px 0;";
    const pauseBtn = mkBtn("Pause", () => {
      this.paused = !this.paused;
      pauseBtn.textContent = this.paused ? "Play" : "Pause";
    });
    row1.appendChild(pauseBtn);
    this.undoBtn = mkBtn("Undo", () => { this.history.undo(); this.update(); });
    row1.appendChild(this.undoBtn);
    this.redoBtn = mkBtn("Redo", () => { this.history.redo(); this.update(); });
    row1.appendChild(this.redoBtn);
    const saveB = mkBtn("Save", () => void this.save());
    row1.appendChild(saveB);
    const loadB = mkBtn("Load", () => this.pickLoad());
    row1.appendChild(loadB);
    this.panel.appendChild(row1);

    const row2 = document.createElement("div");
    row2.style.cssText = "display:flex;gap:6px;margin:0 0 8px 0;";
    row2.appendChild(mkBtn("+ Box", () => this.addCommand("box", () => this.addBox(false))));
    row2.appendChild(mkBtn("+ Static", () => this.addCommand("static", () => this.addBox(true))));
    row2.appendChild(mkBtn("+ Actor", () => this.addCommand("actor", () => this.addActor())));
    row2.appendChild(mkBtn("+ Trigger", () => this.addCommand("trigger", () => this.addTrigger())));
    row2.appendChild(mkBtn("+ FX", () => {
      const fx = this.hooks?.fx?.();
      if (!fx) return;
      let id = -1;
      this.history.execute({
        label: "add fx",
        do: () => { id = fx.attach(fountainDef(), 0, 1, 0); },
        undo: () => { if (id >= 0) fx.detachEmitter(id); },
      });
      this.update();
    }));
    this.panel.appendChild(row2);

    const row3 = document.createElement("div");
    row3.style.cssText = "display:flex;gap:6px;margin:0 0 8px 0;align-items:center;";
    this.snapBtn = mkBtn("Snap 0.5: on", () => {
      this.snapOn = !this.snapOn;
      this.snapBtn.textContent = `Snap 0.5: ${this.snapOn ? "on" : "off"}`;
    });
    row3.appendChild(this.snapBtn);
    const hint = document.createElement("div");
    hint.style.cssText = "opacity:0.6;font-size:11px;";
    hint.textContent = "drag arrows · click picks · Del deletes";
    row3.appendChild(hint);
    this.panel.appendChild(row3);

    this.listEl = document.createElement("div");
    this.infoEl = document.createElement("div");
    this.panel.appendChild(this.listEl);
    this.panel.appendChild(this.infoEl);
    this.panel.style.display = "none";
    root.appendChild(this.panel);

    // Gizmo SVG overlay: arrows get pointer events, everything else passes
    // through to the canvas below.
    this.gizmoSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.gizmoSvg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:15;";
    root.appendChild(this.gizmoSvg);
    this.gizmoSvg.addEventListener("pointerdown", (e) => this.onGizmoDown(e as PointerEvent));
    window.addEventListener("pointermove", (e) => this.onGizmoMove(e as PointerEvent));
    window.addEventListener("pointerup", (e) => this.onGizmoUp(e as PointerEvent));
    // Click (no drag) on the 3D canvas picks an entity via raycast.
    window.addEventListener("pointerdown", (e) => {
      if (e.target instanceof HTMLCanvasElement) this.downAt = { x: e.clientX, y: e.clientY };
      else this.downAt = null;
    });
    window.addEventListener("pointerup", (e) => {
      const down = this.downAt;
      this.downAt = null;
      if (!down || !this.visible || this.drag) return;
      if (!(e.target instanceof HTMLCanvasElement)) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      this.pickAt(e.clientX, e.clientY, e.target);
    });

    window.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === "F9" && tag !== "INPUT") this.toggle();
      if (tag === "INPUT") return;
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ" && !e.shiftKey) {
        e.preventDefault();
        this.history.undo();
        this.update();
      }
      if (((e.ctrlKey || e.metaKey) && e.code === "KeyY") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyZ")) {
        e.preventDefault();
        this.history.redo();
        this.update();
      }
      if ((e.code === "Delete" || e.code === "Backspace") && this.panel.style.display !== "none" && this.selected >= 0) {
        this.deleteSelected();
      }
    });
  }

  toggle() {
    this.panel.style.display = this.panel.style.display === "none" ? "block" : "none";
    if (this.panel.style.display === "none") this.clearGizmo();
  }

  get visible() { return this.panel.style.display !== "none"; }

  isPaused() { return this.paused; }

  historyDepth(): { undo: number; redo: number } {
    return { undo: this.history.depth, redo: this.history.redoDepth };
  }

  // ---- commands ----

  private trackEntity(e: Entity): Entity[] {
    // Deleting an actor head removes its rig parts too.
    const marker = this.world.get<{ parts: Entity[] }>(e, "actor");
    if (marker) {
      const parts = marker.parts.filter((p) => this.world.isAlive(p));
      return [e, ...parts];
    }
    return [e];
  }

  private destroyIds(ids: Entity[]) {
    for (const id of ids) if (this.world.isAlive(id)) this.world.destroy(id);
  }

  deleteSelected() {
    if (this.selected < 0 || !this.world.isAlive(this.selected)) return;
    const ids = this.trackEntity(this.selected);
    const snaps = ids.map((id) => snapEntity(this.world, id));
    const label = `delete #${this.selected}`;
    this.history.execute({
      label,
      do: () => { this.destroyIds(ids); if (this.selected >= 0 && !this.world.isAlive(this.selected)) this.selected = -1; },
      undo: () => {
        const map = restoreSnap(this.world, snaps);
        const root = map.get(ids[0]);
        if (root !== undefined) this.selected = root;
      },
    });
    this.update();
  }

  private addCommand(label: string, build: () => Entity | null) {
    let ids: Entity[] = [];
    this.history.execute({
      label: `add ${label}`,
      do: () => {
        const e = build();
        ids = e === null ? [] : this.trackEntity(e);
        if (e !== null) this.selected = e;
      },
      undo: () => {
        this.destroyIds(ids);
        this.selected = -1;
      },
    });
    this.update();
  }

  private editTransform(label: string, mutate: (t: Transform) => void) {
    const e = this.selected;
    const t = this.world.get<Transform>(e, "transform");
    if (!t) return;
    const before = { pos: t.position.clone(), ry: t.rotationY, scl: t.scale.clone() };
    mutate(t);
    const after = { pos: t.position.clone(), ry: t.rotationY, scl: t.scale.clone() };
    const apply = (s: typeof before) => {
      const tt = this.world.get<Transform>(e, "transform");
      if (!tt) return;
      tt.position.set(s.pos.x, s.pos.y, s.pos.z);
      tt.rotationY = s.ry;
      tt.scale.set(s.scl.x, s.scl.y, s.scl.z);
    };
    this.history.execute({ label, do: () => apply(after), undo: () => apply(before) });
  }

  private async save() {
    const json = saveScene(this.world);
    const pp = this.hooks?.projectPath?.();
    if (pp && window.glitch) {
      try {
        await window.glitch.writeScene(pp, json);
        return;
      } catch { /* fall through to download */ }
    }
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "glitch-scene.json";
    a.click();
  }

  private pickLoad() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.text().then((t) => loadScene(this.world, t, this.hooks?.addTex));
    };
    input.click();
  }

  private addBox(solid: boolean): Entity {
    const e = this.world.create();
    this.world.add(e, "transform", makeTransform(0, 2, 0));
    this.world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [0.6, 0.6, 0.65] });
    if (solid) {
      this.world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: true });
      this.world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: false, mass: 0, grounded: true });
    }
    return e;
  }

  private addTrigger(): Entity {
    const e = this.world.create();
    this.world.add(e, "transform", makeTransform(0, 1, 0));
    this.world.add(e, "trigger", { halfExtents: new Vec3(1.5, 1.5, 1.5), entered: false });
    return e;
  }

  private addActor(): Entity | null {
    if (!this.hooks) return null;
    const tag = `actor-${Date.now() % 100000}-${this.actorSeq++}`;
    const opts = {
      skin: [0.92, 0.74, 0.58] as [number, number, number],
      shirt: [0.3, 0.6, 0.5] as [number, number, number],
      trim: [0.18, 0.35, 0.3] as [number, number, number],
      pants: [0.2, 0.2, 0.24] as [number, number, number],
      hair: [0.2, 0.14, 0.1] as [number, number, number],
      face: { eye: "round" as const, mouth: "smile" as const, blush: false, beard: false },
      tag,
    };
    const rig = buildActor(this.world, this.hooks.addTex, opts);
    poseActor(this.world, rig, 0, 0, 2, 0, 0, false);
    return rig.head;
  }

  // ---- gizmo + picking ----

  private viewportOf() {
    return this.hooks?.viewport?.() ?? null;
  }

  private clearGizmo() {
    while (this.gizmoSvg.firstChild) this.gizmoSvg.removeChild(this.gizmoSvg.firstChild);
  }

  private arrow(
    x1: number, y1: number, x2: number, y2: number, color: string, axis: Vec3
  ) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "5");
    line.setAttribute("stroke-linecap", "round");
    (line as SVGLineElement).style.pointerEvents = "visibleStroke";
    (line as unknown as { __axis: Vec3 }).__axis = axis;
    this.gizmoSvg.appendChild(line);
  }

  private drawGizmo() {
    this.clearGizmo();
    if (!this.visible || this.selected < 0) return;
    const t = this.world.get<Transform>(this.selected, "transform");
    const vp = this.viewportOf();
    if (!t || !vp) return;
    const m = viewProj(vp.view, vp.proj);
    const origin = worldToScreen(m, vp.width, vp.height, t.position);
    if (origin.behind) return;
    const axes: { dir: Vec3; color: string }[] = [
      { dir: new Vec3(1, 0, 0), color: "#ef4444" },
      { dir: new Vec3(0, 1, 0), color: "#22c55e" },
      { dir: new Vec3(0, 0, 1), color: "#3b82f6" },
    ];
    for (const a of axes) {
      const tip = worldToScreen(
        m, vp.width, vp.height,
        new Vec3(t.position.x + a.dir.x * 1.6, t.position.y + a.dir.y * 1.6, t.position.z + a.dir.z * 1.6)
      );
      if (tip.behind) continue;
      this.arrow(origin.x, origin.y, tip.x, tip.y, a.color, a.dir);
    }
  }

  private onGizmoDown(e: PointerEvent) {
    const target = e.target as SVGLineElement | null;
    const axis = (target as unknown as { __axis?: Vec3 } | null)?.__axis;
    if (!axis || this.selected < 0) return;
    const t = this.world.get<Transform>(this.selected, "transform");
    const vp = this.viewportOf();
    if (!t || !vp) return;
    const m = viewProj(vp.view, vp.proj);
    const rect = this.gizmoSvg.getBoundingClientRect();
    const ray = screenRay(m, vp.width, vp.height, e.clientX - rect.left, e.clientY - rect.top);
    if (!ray) return;
    const hit = axisParam(ray.origin, ray.dir, t.position, axis);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    this.drag = {
      axis: axis.clone(),
      startAxisT: hit.axisT,
      startPos: t.position.clone(),
      before: { pos: [t.position.x, t.position.y, t.position.z] },
    };
  }

  private onGizmoMove(e: PointerEvent) {
    if (!this.drag || this.selected < 0) return;
    const t = this.world.get<Transform>(this.selected, "transform");
    const vp = this.viewportOf();
    if (!t || !vp) { this.drag = null; return; }
    const m = viewProj(vp.view, vp.proj);
    const rect = this.gizmoSvg.getBoundingClientRect();
    const ray = screenRay(m, vp.width, vp.height, e.clientX - rect.left, e.clientY - rect.top);
    if (!ray) return;
    const hit = axisParam(ray.origin, ray.dir, this.drag.startPos, this.drag.axis);
    if (!hit) return;
    let delta = hit.axisT - this.drag.startAxisT;
    if (this.snapOn) {
      const from = this.drag.startPos;
      const snapped = new Vec3(
        from.x + this.drag.axis.x * delta,
        from.y + this.drag.axis.y * delta,
        from.z + this.drag.axis.z * delta
      );
      snapped.x = snapValue(snapped.x, this.snapSize);
      snapped.y = snapValue(snapped.y, this.snapSize);
      snapped.z = snapValue(snapped.z, this.snapSize);
      // Re-derive the scalar delta along the axis from the snapped point.
      delta = (snapped.x - from.x) * this.drag.axis.x
        + (snapped.y - from.y) * this.drag.axis.y
        + (snapped.z - from.z) * this.drag.axis.z;
    }
    t.position.set(
      this.drag.startPos.x + this.drag.axis.x * delta,
      this.drag.startPos.y + this.drag.axis.y * delta,
      this.drag.startPos.z + this.drag.axis.z * delta
    );
  }

  private onGizmoUp(e: PointerEvent) {
    void e;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const t = this.selected >= 0 ? this.world.get<Transform>(this.selected, "transform") : undefined;
    if (!t) return;
    const afterPos: [number, number, number] = [t.position.x, t.position.y, t.position.z];
    const moved = afterPos.some((v, i) => Math.abs(v - d.before.pos[i]) > 1e-9);
    if (!moved) return;
    const sel = this.selected;
    this.history.execute({
      label: "move",
      do: () => {
        const tt = this.world.get<Transform>(sel, "transform");
        if (tt) tt.position.set(afterPos[0], afterPos[1], afterPos[2]);
      },
      undo: () => {
        const tt = this.world.get<Transform>(sel, "transform");
        if (tt) tt.position.set(d.before.pos[0], d.before.pos[1], d.before.pos[2]);
      },
    });
    this.update();
  }

  private pickAt(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
    const vp = this.viewportOf();
    if (!vp) return;
    const rect = canvas.getBoundingClientRect();
    const ray = screenRay(
      viewProj(vp.view, vp.proj), vp.width, vp.height,
      clientX - rect.left, clientY - rect.top
    );
    if (!ray) return;
    const hit = raycastScene(this.world, {
      origin: ray.origin,
      direction: ray.dir,
      maxDist: 500,
    });
    if (hit) {
      this.selected = hit.entity;
      this.update();
    }
  }

  update() {
    if (!this.visible) {
      this.clearGizmo();
      return;
    }
    this.undoBtn.textContent = `Undo${this.history.depth > 0 ? ` (${this.history.depth})` : ""}`;
    this.redoBtn.textContent = `Redo${this.history.redoDepth > 0 ? ` (${this.history.redoDepth})` : ""}`;
    const entities = this.world.query("transform");
    this.listEl.innerHTML = `<div style="opacity:0.7;margin:4px 0;">${entities.length} entities (Del removes)</div>`;
    for (const e of entities.slice(0, 80)) {
      const b = document.createElement("button");
      const isActor = this.world.has(e, "actor");
      b.textContent = isActor ? `#${e} actor` : `#${e}`;
      b.style.cssText = `margin:2px;padding:2px 6px;background:${e === this.selected ? "#0f766e" : "#0f172a"};color:#fff;border:1px solid #334155;border-radius:4px;cursor:pointer;`;
      b.onclick = () => { this.selected = e; this.renderInspector(); this.drawGizmo(); };
      this.listEl.appendChild(b);
    }
    this.renderInspector();
    this.drawGizmo();
  }

  private num(label: string, get: () => number, set: (v: number) => void): HTMLElement {
    const wrap = document.createElement("span");
    wrap.innerHTML = `<span style="opacity:0.6">${label}</span> `;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "0.5";
    inp.value = get().toFixed(2);
    inp.style.cssText = "width:64px;background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;";
    inp.onchange = () => { const v = Number(inp.value); if (isFinite(v)) set(v); };
    wrap.appendChild(inp);
    return wrap;
  }

  private renderInspector() {
    if (this.selected < 0) { this.infoEl.innerHTML = "<div style='opacity:0.6'>No selection</div>"; return; }
    const t = this.world.get<Transform>(this.selected, "transform");
    if (!t) { this.infoEl.innerHTML = "<div>Entity removed</div>"; this.selected = -1; return; }
    this.infoEl.innerHTML = `<div style="margin-top:8px;border-top:1px solid #334155;padding-top:6px;"><div>Entity #${this.selected}</div></div>`;
    const sel = this.selected;
    const applyTriple = (id: Entity, kind: "pos" | "ry" | "scale", v: [number, number, number]) => {
      const tt = this.world.get<Transform>(id, "transform");
      if (!tt) return;
      if (kind === "pos") tt.position.set(v[0], v[1], v[2]);
      else if (kind === "ry") tt.rotationY = v[0];
      else tt.scale.set(v[0], v[1], v[2]);
    };
    const pushTriple = (label: string, kind: "pos" | "ry" | "scale", before: [number, number, number], after: [number, number, number]) => {
      this.history.execute({
        label,
        do: () => applyTriple(sel, kind, after),
        undo: () => applyTriple(sel, kind, before),
      });
    };
    const triple = (
      label: string,
      kind: "pos" | "ry" | "scale",
      get: () => [number, number, number],
      setImmediate: (v: [number, number, number]) => void
    ) => {
      const outer = document.createElement("div");
      const lab = document.createElement("div");
      lab.style.cssText = "opacity:0.6;font-size:11px;";
      lab.textContent = label;
      outer.appendChild(lab);
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;gap:2px;margin-top:2px;";
      const axes = kind === "ry" ? (["x"] as const) : (["x", "y", "z"] as const);
      axes.forEach((axis, i) => {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = "0.5";
        inp.title = `${label}.${axis}`;
        inp.value = get()[i].toFixed(2);
        inp.style.cssText = "width:56px;background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;margin-right:2px;";
        inp.onchange = () => {
          const v = Number(inp.value);
          if (!isFinite(v)) return;
          const before = get();
          const after: [number, number, number] = [...before] as [number, number, number];
          after[i] = v;
          setImmediate(after);
          pushTriple(label, kind, before, after);
        };
        wrap.appendChild(inp);
      });
      outer.appendChild(wrap);
      return outer;
    };
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;";
    box.appendChild(triple("pos", "pos", () => [t.position.x, t.position.y, t.position.z], (v) => t.position.set(v[0], v[1], v[2])));
    box.appendChild(triple("rotY", "ry", () => [t.rotationY, 0, 0], (v) => { t.rotationY = v[0]; }));
    box.appendChild(triple("scale", "scale", () => [t.scale.x, t.scale.y, t.scale.z], (v) => t.scale.set(v[0], v[1], v[2])));
    this.infoEl.appendChild(box);
    const m = this.world.get<MeshRef>(this.selected, "mesh");
    if (m) {
      const crow = document.createElement("div");
      crow.style.cssText = "margin-top:6px;";
      crow.innerHTML = `<span style="opacity:0.6">color</span> `;
      const ci = document.createElement("input");
      ci.type = "color";
      const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
      ci.value = `#${toHex(m.color[0])}${toHex(m.color[1])}${toHex(m.color[2])}`;
      ci.onchange = () => {
        const h = ci.value;
        const before: [number, number, number] = [...m.color] as [number, number, number];
        m.color = [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
        const after: [number, number, number] = [...m.color] as [number, number, number];
        const sel = this.selected;
        this.history.execute({
          label: "color",
          do: () => { const mm = this.world.get<MeshRef>(sel, "mesh"); if (mm) mm.color = [...after] as [number, number, number]; },
          undo: () => { const mm = this.world.get<MeshRef>(sel, "mesh"); if (mm) mm.color = [...before] as [number, number, number]; },
        });
      };
      crow.appendChild(ci);
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.style.cssText = "margin-left:8px;padding:2px 8px;background:#7f1d1d;color:#fff;border:1px solid #991b1b;border-radius:4px;cursor:pointer;";
      del.onclick = () => this.deleteSelected();
      crow.appendChild(del);
      this.infoEl.appendChild(crow);
      this.renderMaterialSection(m);
    }
  }

  private slider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:4px;";
    wrap.innerHTML = `<span style="opacity:0.6">${label} </span>`;
    const val = document.createElement("span");
    val.textContent = get().toFixed(2);
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(get());
    inp.style.cssText = "width:130px;vertical-align:middle;";
    inp.oninput = () => { const v = Number(inp.value); if (isFinite(v)) { set(v); val.textContent = v.toFixed(2); } };
    wrap.appendChild(inp);
    wrap.appendChild(val);
    return wrap;
  }

  // Material workflow: pick a registered material (or Duplicate-then-edit so
  // shared presets stay pristine), tune the key PBR knobs live.
  private renderMaterialSection(m: MeshRef) {
    const db = this.hooks?.mats;
    const sec = document.createElement("div");
    sec.style.cssText = "margin-top:8px;border-top:1px solid #334155;padding-top:6px;";
    if (!db) {
      sec.innerHTML = `<div style="opacity:0.6">materials: no library bound</div>`;
      this.infoEl.appendChild(sec);
      return;
    }
    sec.innerHTML = `<div><span style="opacity:0.6">material</span></div>`;
    const sel = document.createElement("select");
    sel.style.cssText = "background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;margin-top:4px;";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(legacy shading)";
    sel.appendChild(none);
    for (const id of db.ids()) {
      const op = document.createElement("option");
      op.value = id;
      op.textContent = id;
      if (m.materialId === id) op.selected = true;
      sel.appendChild(op);
    }
    sel.onchange = () => {
      const before = m.materialId;
      const after = sel.value === "" ? undefined : sel.value;
      m.materialId = after;
      const s = this.selected;
      this.history.execute({
        label: "material",
        do: () => { const mm = this.world.get<MeshRef>(s, "mesh"); if (mm) mm.materialId = after; },
        undo: () => { const mm = this.world.get<MeshRef>(s, "mesh"); if (mm) mm.materialId = before; },
      });
      this.renderInspector();
    };
    sec.appendChild(sel);
    const mat = m.materialId ? db.get(m.materialId) : undefined;
    if (mat) {
      sec.appendChild(this.slider("metallic", 0, 1, 0.05, () => mat.metallic, (v) => { mat.metallic = v; }));
      sec.appendChild(this.slider("roughness", 0, 1, 0.05, () => mat.roughness, (v) => { mat.roughness = v; }));
      sec.appendChild(this.slider("emission", 0, 4, 0.1, () => mat.emissiveIntensity, (v) => { mat.emissiveIntensity = v; }));
      const row = document.createElement("div");
      row.style.cssText = "margin-top:4px;display:flex;gap:6px;align-items:center;";
      const modes: ["opaque", "mask", "blend"] = ["opaque", "mask", "blend"];
      const ms = document.createElement("select");
      ms.style.cssText = "background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;";
      for (const mode of modes) {
        const op = document.createElement("option");
        op.value = mode;
        op.textContent = mode;
        if (mat.alphaMode === mode) op.selected = true;
        ms.appendChild(op);
      }
      ms.onchange = () => { mat.alphaMode = ms.value as "opaque" | "mask" | "blend"; };
      row.appendChild(ms);
      const ds = document.createElement("label");
      ds.style.cssText = "font-size:11px;opacity:0.8;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = mat.doubleSided;
      cb.onchange = () => { mat.doubleSided = cb.checked; };
      ds.appendChild(cb);
      ds.appendChild(document.createTextNode(" double-sided"));
      row.appendChild(ds);
      const dup = document.createElement("button");
      dup.textContent = "Duplicate";
      dup.style.cssText = "padding:2px 8px;background:#1e293b;color:#fff;border:1px solid #475569;border-radius:4px;cursor:pointer;";
      dup.onclick = () => {
        const id = `${m.materialId}-copy`;
        try {
          db.duplicate(m.materialId!, id);
          m.materialId = id;
          this.renderInspector();
        } catch {
          m.materialId = id + "-" + Date.now().toString(36);
          db.duplicate(sel.value, m.materialId);
          this.renderInspector();
        }
      };
      row.appendChild(dup);
      sec.appendChild(row);
    }
    this.infoEl.appendChild(sec);
  }
}
