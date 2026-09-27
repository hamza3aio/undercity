// Glitch asset browser (Phase 5) — project-style panel for the AssetDB and
// the import queue. Pure DOM; all data comes from AssetDB/ImportPipeline.
//
// What it does: lists assets grouped by kind, filters by text and kind,
// shows import settings + dependencies for the selection, offers reimport /
// remove / create, and shows live import progress. Drag-and-drop of files
// is wired to the import queue.

import type { AssetDB, AssetMeta } from "../assets/db.js";
import type { ImportPipeline } from "../assets/pipeline.js";
import type { QualityLevel, QualitySettings } from "../core/quality.js";
import { QUALITY_LEVELS } from "../core/quality.js";

export interface AssetBrowserHooks {
  /** Reimport an asset (re-reads the file through the host). */
  reimport?: (meta: AssetMeta) => void;
  /** Remove from the database. */
  remove?: (meta: AssetMeta) => void;
  /** Called when a file is dropped or picked. */
  importFile?: (name: string, data: ArrayBuffer | string) => void;
  quality?: QualitySettings;
}

export function mountAssetBrowser(
  parent: HTMLElement,
  db: AssetDB,
  pipeline: ImportPipeline,
  hooks: AssetBrowserHooks = {}
): { root: HTMLElement; refresh: () => void; destroy: () => void } {
  const root = document.createElement("div");
  root.style.cssText = "position:absolute;left:12px;top:60px;width:290px;max-height:70vh;display:flex;flex-direction:column;"
    + "background:rgba(10,14,22,0.94);border:1px solid #334155;border-radius:8px;z-index:20;font-size:12px;color:#d6e2f0";

  const head = document.createElement("div");
  head.style.cssText = "padding:8px;border-bottom:1px solid #1e293b;display:flex;gap:6px;align-items:center;flex-wrap:wrap";
  const title = document.createElement("strong");
  title.textContent = "Assets";
  head.appendChild(title);
  const count = document.createElement("span");
  count.style.cssText = "opacity:0.65";
  head.appendChild(count);
  root.appendChild(head);

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "filter…";
  search.style.cssText = "flex:1;min-width:70px;background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 6px";
  head.appendChild(search);

  const kindSel = document.createElement("select");
  kindSel.style.cssText = "background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 4px";
  const allKind = document.createElement("option");
  allKind.value = "";
  allKind.textContent = "all";
  kindSel.appendChild(allKind);
  for (const k of ["texture", "model", "material", "scene", "audio", "script"]) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    kindSel.appendChild(o);
  }
  head.appendChild(kindSel);

  if (hooks.quality) {
    const q = document.createElement("select");
    q.style.cssText = "background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 4px";
    for (const l of QUALITY_LEVELS) {
      const o = document.createElement("option");
      o.value = l;
      o.textContent = l;
      if (l === hooks.quality.level) o.selected = true;
      o.title = `texture max ${hooks.quality.config.textureMaxSize}`;
      q.appendChild(o);
    }
    q.onchange = () => hooks.quality?.applyPreset(q.value as QualityLevel);
    head.appendChild(q);
  }

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow:auto;padding:4px 6px";
  root.appendChild(list);

  const detail = document.createElement("div");
  detail.style.cssText = "border-top:1px solid #1e293b;padding:6px;max-height:30vh;overflow:auto;opacity:0.9";
  root.appendChild(detail);

  const queue = document.createElement("div");
  queue.style.cssText = "border-top:1px solid #1e293b;padding:6px;max-height:22vh;overflow:auto";
  root.appendChild(queue);

  let selected: string | null = null;

  const renderDetail = () => {
    if (!selected) {
      detail.textContent = "select an asset";
      return;
    }
    const a = db.get(selected);
    if (!a) {
      detail.textContent = "";
      return;
    }
    const deps = a.dependencies.map((d) => db.get(d)?.path ?? d);
    const settings = Object.entries(a.settings)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("  ");
    detail.innerHTML = "";
    const line = (s: string, bold = false) => {
      const d = document.createElement("div");
      d.textContent = s;
      if (bold) d.style.fontWeight = "600";
      detail.appendChild(d);
      return d;
    };
    line(a.path, true);
    line(`${a.kind} · ${a.guid.slice(0, 8)}…`);
    if (settings) line(settings);
    line(`deps: ${deps.length ? deps.join(", ") : "none"}`);
    line(a.hash ? `hash ${a.hash}` : "never imported");
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;margin-top:4px";
    const re = document.createElement("button");
    re.textContent = "reimport";
    re.disabled = !hooks.reimport;
    const del = document.createElement("button");
    del.textContent = "delete";
    del.disabled = !hooks.remove;
    for (const [b, fn] of [[re, hooks.reimport], [del, hooks.remove]] as const) {
      b.style.cssText = "padding:2px 8px;background:#1e293b;color:#fff;border:1px solid #475569;border-radius:4px;cursor:pointer";
      b.onclick = () => { if (fn) fn(a); refresh(); };
      row.appendChild(b);
    }
    detail.appendChild(row);
  };

  const renderQueue = () => {
    const jobs = pipeline.jobs.slice(-6).reverse();
    queue.textContent = "";
    const h = document.createElement("div");
    h.style.cssText = "opacity:0.7;margin-bottom:2px";
    h.textContent = `import queue (${pipeline.pending} pending)`;
    queue.appendChild(h);
    if (jobs.length === 0) {
      const e = document.createElement("div");
      e.style.opacity = "0.5";
      e.textContent = "drop a .obj / .gltf / .glb file here";
      queue.appendChild(e);
      return;
    }
    for (const j of jobs) {
      const row = document.createElement("div");
      const color = j.status === "failed" ? "#f87171" : j.status === "done" ? "#7dd3fc" : "#cbd5e1";
      row.style.color = color;
      const label = j.status === "failed" ? `${j.name}: ${j.error}` : `${j.name} — ${j.status} ${Math.round(j.progress * 100)}%`;
      row.textContent = label;
      queue.appendChild(row);
      for (const w of j.warnings.slice(0, 2)) {
        const wr = document.createElement("div");
        wr.style.cssText = "opacity:0.6;padding-left:8px";
        wr.textContent = w;
        queue.appendChild(wr);
      }
    }
  };

  const refresh = () => {
    const q = search.value.trim().toLowerCase();
    const kind = kindSel.value;
    const all = db.list().filter((a) => (!kind || a.kind === kind)
      && (!q || a.path.toLowerCase().includes(q) || a.kind.includes(q)));
    all.sort((a, b) => a.path.localeCompare(b.path));
    count.textContent = `${all.length}/${db.count}`;
    list.textContent = "";
    if (all.length === 0) {
      const e = document.createElement("div");
      e.style.opacity = "0.5";
      e.textContent = "no assets";
      list.appendChild(e);
    }
    for (const a of all) {
      const row = document.createElement("div");
      row.style.cssText = "padding:2px 4px;border-radius:3px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
      row.textContent = `${a.kind === "model" ? "▣" : a.kind === "texture" ? "▨" : "•"} ${a.path}`;
      row.title = `${a.path}\n${a.guid}`;
      if (a.guid === selected) row.style.background = "#1e293b";
      row.onclick = () => {
        selected = a.guid;
        refresh();
      };
      list.appendChild(row);
    }
    renderDetail();
    renderQueue();
  };

  search.oninput = () => refresh();
  kindSel.onchange = () => refresh();

  // Drop target: files go straight into the import queue.
  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.style.borderColor = "#2dd4bf";
  });
  root.addEventListener("dragleave", () => {
    root.style.borderColor = "#334155";
  });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    root.style.borderColor = "#334155";
    if (!hooks.importFile) return;
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      const isText = /\.(obj|gltf|json|txt|cubedef)$/i.test(f.name);
      if (isText) {
        void f.text().then((t) => hooks.importFile!(f.name, t));
      } else {
        void f.arrayBuffer().then((b) => hooks.importFile!(f.name, b));
      }
    }
  });

  parent.appendChild(root);
  refresh();
  const timer = window.setInterval(refresh, 500);
  return {
    root,
    refresh,
    destroy: () => {
      window.clearInterval(timer);
      root.remove();
    },
  };
}
