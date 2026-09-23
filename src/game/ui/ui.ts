import {
  ACT_NAMES, CONTRACTS, CUSTOMERS, FACTIONS, NPCS, PRODUCTS, PROPERTIES, VEHICLES,
  type Quality,
} from "../data/world.js";
import { ADDITIVES } from "../data/street.js";
import { BIG_SPEND_CONFIRM, DEPOSIT_LIMIT, fairFor, heatLabel, relStage, satLabel, type EmpireSim, type OpResult } from "../sim/sim.js";

export interface Settings { preset: "Low" | "Medium" | "High" | "Ultra"; fullscreen: boolean; music: boolean; volume: number; }

export interface UIActions {
  deposit(amount: number): OpResult;
  withdraw(amount: number): OpResult;
  buyProperty(id: string, confirmed: boolean): OpResult;
  upgradeProperty(id: string, confirmed: boolean): OpResult;
  buyVehicle(id: string, owner: "empire" | "player", confirmed: boolean): OpResult;
  buyMaterials(n: number): OpResult;
  mixBatch(idx: number, additive: string, name: string): OpResult;
  stashCash(prop: string, n: number): OpResult;
  unstashCash(prop: string, n: number): OpResult;
  produce(product: string, quality: Quality): OpResult;
  sell(customerId: string, batch: number, price: number): OpResult;
  talk(npcId: string, choice: number): OpResult;
  recruit(npcId: string): OpResult;
  assign(npcId: string, prop: string | null): OpResult;
  payTribute(amount: number): OpResult;
  dealTo(walker: number, customer: string, batch: number, price: number): void;
  lobby(op: string, payload: string): Promise<string>;
  quitToMenu(): void;
  startJob(contractId: string): void;
  setCharacter(name: string, body: [number, number, number], accent: [number, number, number], hat: boolean): void;
  save(): void;
  newGame(): void;
  applySettings(s: Settings): void;
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error("missing #" + id);
  return e;
}

const BODY_COLORS: [number, number, number][] = [[0.2, 0.5, 1.0], [0.9, 0.3, 0.3], [0.3, 0.8, 0.4], [0.9, 0.85, 0.3], [0.7, 0.4, 0.9], [0.9, 0.5, 0.15]];
const ACCENT_COLORS: [number, number, number][] = [[1.0, 0.75, 0.2], [0.3, 0.9, 0.9], [1.0, 0.4, 0.6], [0.5, 1.0, 0.4], [0.9, 0.9, 0.9]];

function css(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

export class GameUI {
  settings: Settings = { preset: "High", fullscreen: false, music: false, volume: 0.8 };
  selectedBatch = 0;
  fps = 0;
  private openPanel: string | null = null;
  private toastTimer = 0;
  private lobbyMsg = "";
  private inviteCode = "";
  private joinCode = "";
  private answerIn = "";
  private lobbyName = "";

  constructor(private sim: EmpireSim, private actions: UIActions) {
    const buttons: [string, string, string][] = [
      ["jobs", "Jobs (J)", "jobs"], ["bank", "Bank (B)", "bank"], ["props", "Props (P)", "props"],
      ["cars", "Cars (V)", "cars"], ["people", "People (N)", "people"], ["biz", "Biz (U)", "biz"],
      ["you", "You (C)", "you"], ["lobby", "Lobby (L)", "lobby"], ["set", "Settings (G)", "settings"], ["help", "Help (H)", "help"],
    ];
    const bar = el("menubar");
    for (const [id, label, panel] of buttons) {
      const b = document.createElement("button");
      b.textContent = label;
      b.id = "mb-" + id;
      b.onclick = () => this.toggle(panel);
      bar.appendChild(b);
    }
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      const map: Record<string, string> = { KeyJ: "jobs", KeyB: "bank", KeyP: "props", KeyV: "cars", KeyN: "people", KeyU: "biz", KeyC: "you", KeyL: "lobby", KeyG: "settings", KeyH: "help" };
      const p = map[e.code];
      if (p) { e.preventDefault(); this.toggle(p); }
      if (e.code === "Escape") this.closePanel();
    });
  }

  district = "Streets";

  refreshTop() {
    const s = this.sim.s;
    el("topbar").innerHTML =
      `<span class="brand">UNDERCITY</span>` +
      `<span>Wallet <b>$${Math.floor(s.wallet).toLocaleString()}</b></span>` +
      `<span>Empire Bank <b>$${Math.floor(s.bank).toLocaleString()}</b></span>` +
      `<span>Rep <b>${s.rep}</b>/100</span>` +
      `<span class="${s.heat >= 70 ? "neg" : ""}">Heat <b>${Math.floor(s.heat)}</b> (${heatLabel(s.heat)})</span>` +
      `<span>${this.sim.clockText()}</span>` +
      `<span>${s.empireMode ? "EMPIRE MODE" : ACT_NAMES[s.act]}</span>` +
      `<span class="muted">${this.district}</span>` +
      `<span class="muted">FPS ${this.fps}</span>`;
  }

  setObjective(actLine: string, title: string, desc: string, progress: string) {
    el("objective").innerHTML = `<div class="act">${actLine}</div><div class="title">${title}</div><div>${desc}</div><div class="muted">${progress}</div>`;
  }

  showPrompt(html: string | null) {
    const p = el("prompt");
    if (!html) { p.style.display = "none"; return; }
    p.style.display = "block";
    p.innerHTML = html;
  }

  channel(label: string | null, frac: number) {
    const c = el("channel");
    if (!label) { c.style.display = "none"; return; }
    c.style.display = "block";
    c.innerHTML = `<div>${label}</div><div class="bar"><div class="fill" style="width:${Math.round(frac * 100)}%"></div></div>`;
  }

  toast(text: string, ms = 2200) {
    const t = el("toast");
    t.textContent = text;
    t.style.display = "block";
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { t.style.display = "none"; }, ms);
  }

  refreshLog() {
    el("gamelog").innerHTML = this.sim.s.log.slice(0, 4).map((l) => `<div>${l}</div>`).join("");
  }

  renderHotbar() {
    const bar = el("hotbar");
    const stock = this.sim.s.stock;
    let html = "";
    for (let i = 0; i < 8; i++) {
      const b = stock[i];
      html += `<div class="slot${i === this.selectedBatch && b ? " sel" : ""}>${b ? `${b.units}u<br>${b.label.slice(0, 10)}` : ""}<span class="key">${i + 1}</span></div>`;
    }
    html += `<div class="cash">$${Math.floor(this.sim.s.wallet).toLocaleString()}</div>`;
    bar.innerHTML = html;
  }

  renderCompass(yaw: number) {
    const fx = -Math.cos(yaw), fz = -Math.sin(yaw);
    const deg = Math.round(((Math.atan2(fx, fz) * 180) / Math.PI + 360) % 360);
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    el("compass").textContent = `${dirs[Math.round(deg / 45) % 8]} · ${deg}°`;
  }

  credits() {
    this.modal(`<h2>UNDERCITY</h2><div>An original game built with Glitch Game Engine.</div>
      <div class="muted" style="margin-top:6px;">Design, code, city, story and audio synthesized in-engine. No third-party assets. No fixed roles — every player is crew.</div>`,
      [{ label: "Back", fn: () => undefined }]);
  }

  toggle(panel: string) {
    if (this.openPanel === panel) { this.closePanel(); return; }
    this.openPanel = panel;
    for (const b of Array.from(el("menubar").children)) b.classList.remove("active");
    const btn = { jobs: "mb-jobs", bank: "mb-bank", props: "mb-props", cars: "mb-cars", people: "mb-people", biz: "mb-biz", you: "mb-you", lobby: "mb-lobby", settings: "mb-set", help: "mb-help" }[panel];
    if (btn) el(btn).classList.add("active");
    this.render();
  }

  closePanel() {
    this.openPanel = null;
    el("panel").style.display = "none";
    for (const b of Array.from(el("menubar").children)) b.classList.remove("active");
  }

  refresh() {
    this.refreshTop();
    if (this.openPanel) this.render();
  }

  private handle(r: OpResult, retry?: () => OpResult) {
    if (r.needConfirm && retry) {
      this.modal(`<h2>Confirm empire spend</h2><div>${r.msg}</div><div style="margin-top:10px;">Spends above $${BIG_SPEND_CONFIRM.toLocaleString()} need explicit confirmation.</div>`,
        [{ label: "Confirm", primary: true, fn: () => { const r2 = retry(); this.toast(r2.msg); this.refresh(); } }, { label: "Cancel", fn: () => undefined }]);
    } else {
      this.toast(r.msg);
    }
    this.refresh();
  }

  modal(html: string, buttons: { label: string; primary?: boolean; fn: () => void }[]) {
    const m = el("modal");
    m.style.display = "flex";
    m.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = html;
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      if (b.primary) btn.className = "primary";
      btn.onclick = () => { m.style.display = "none"; m.innerHTML = ""; b.fn(); this.refresh(); };
      card.appendChild(btn);
    }
    m.appendChild(card);
  }

  characterCreation() {
    const s = this.sim.s;
    let body = s.character.body; let accent = s.character.accent; let hat = false;
    const swRow = (colors: [number, number, number][], initial: [number, number, number], pick: (c: [number, number, number]) => void) => {
      const row = document.createElement("div");
      row.className = "swatches";
      for (const c of colors) {
        const d = document.createElement("div");
        d.className = "sw";
        d.style.background = css(c);
        d.onclick = () => { pick(c); for (const x of Array.from(row.children)) x.classList.remove("sel"); d.classList.add("sel"); };
        if (c === initial) d.classList.add("sel");
        row.appendChild(d);
      }
      return row;
    };
    const m = el("modal");
    m.style.display = "flex";
    m.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h2>WHO ARRIVES IN THE CITY?</h2><div class="muted">No fixed roles. Every player is an equal member of the empire — build any skills you like.</div>
      <div style="margin-top:10px;">Name</div>`;
    const input = document.createElement("input");
    input.maxLength = 16;
    input.placeholder = "Your name";
    card.appendChild(input);
    card.appendChild(document.createTextNode("Jacket"));
    card.appendChild(swRow(BODY_COLORS, BODY_COLORS[0], (c) => { body = c; }));
    card.appendChild(document.createTextNode("Accent"));
    card.appendChild(swRow(ACCENT_COLORS, ACCENT_COLORS[0], (c) => { accent = c; }));
    const hatLabel = document.createElement("label");
    hatLabel.innerHTML = `<input type="checkbox" style="width:auto;"> Hat`;
    hatLabel.querySelector("input")!.onchange = (e) => { hat = (e.target as HTMLInputElement).checked; };
    card.appendChild(hatLabel);
    const go = document.createElement("button");
    go.className = "primary";
    go.textContent = "Enter the city";
    go.onclick = () => {
      const name = input.value.trim() || "Nobody";
      this.actions.setCharacter(name, body, accent, hat);
      m.style.display = "none"; m.innerHTML = "";
      this.toast(`Welcome, ${name}. Talk to Bram in Rust Flats (gold beacons mark work sites).`);
      this.refresh();
    };
    card.appendChild(document.createElement("br"));
    card.appendChild(go);
    m.appendChild(card);
  }

  bustedModal(stockLost: number, cashLost: number) {
    this.modal(`<h2 style="color:#f87171;">BUSTED BY THE WARDENS</h2>
      <div>They seized <b>${stockLost}u</b> of stock and <b>$${cashLost}</b> from your wallet.</div>
      <div class="muted" style="margin-top:6px;">Stashed cash is untouched. Patrols back off for a while — cool your Heat.</div>`,
      [{ label: "Back to the streets", primary: true, fn: () => undefined }]);
  }

  dealDialog(profileId: string, walkerIdx: number) {
    const cust = CUSTOMERS.find((c) => c.id === profileId);
    if (!cust) return;
    const stock = this.sim.s.stock;
    if (stock.length === 0) {
      this.modal(`<h2>STREET DEAL</h2><div>You're holding nothing. Refine a batch in <b>Biz (U)</b> first.</div>`,
        [{ label: "Close", fn: () => undefined }]);
      return;
    }
    const sat = this.sim.s.sat[profileId] ?? 50;
    const bi = Math.min(this.selectedBatch, stock.length - 1);
    const b = stock[bi];
    const fair = fairFor(b, profileId);
    const opts = stock.map((x, i) => `${i}: ${x.units}u ${x.label} (${x.quality})`).join("\n");
    this.modal(`<h2>STREET DEAL</h2>
      <div class="muted">Buyer: <b>${cust.name}</b> — wants ${cust.preferredQuality}, pays ~$${cust.preferredPrice}, ${cust.priceSensitivity} sensitivity. Standing: ${satLabel(sat)} (${sat}).</div>
      <div style="margin-top:8px;">Offering oldest first: <b>${b.units}u ${b.label} (${b.quality})</b> — fair $${fair}/u.</div>
      <div class="muted" style="white-space:pre-line;">Your stock:\n${opts}</div>`,
      [
        { label: `Sell @ $${fair}/u`, primary: true, fn: () => this.actions.dealTo(walkerIdx, profileId, bi, fair) },
        { label: `Haggle $${Math.round(fair * 1.2)}/u`, fn: () => this.actions.dealTo(walkerIdx, profileId, bi, Math.round(fair * 1.2)) },
        { label: "Walk away", fn: () => undefined },
      ]);
  }

  talkDialog(npcId: string) {
    const def = NPCS.find((n) => n.id === npcId);
    if (!def) return;
    const rel = this.sim.s.rel[npcId] ?? 0;
    const canRecruit = !!def.recruitable && rel >= 70 && !this.sim.s.employees.some((e) => e.npcId === npcId);
    this.modal(`<h2>${def.name}</h2><div class="muted">${def.role} — ${relStage(rel)} (${rel})</div><div style="margin:8px 0;">${def.blurb}</div>`,
      [
        { label: "Friendly: ask about work", fn: () => this.handle(this.actions.talk(npcId, 0)) },
        { label: "Professional: talk business", fn: () => this.handle(this.actions.talk(npcId, 1)) },
        { label: "Blunt: get to the point", fn: () => this.handle(this.actions.talk(npcId, 2)) },
        ...(canRecruit ? [{ label: "Offer Employment", primary: true, fn: () => this.handle(this.actions.recruit(npcId)) }] : []),
        { label: "Leave", fn: () => undefined },
      ]);
  }

  private render() {
    const p = el("panel");
    p.style.display = "block";
    const s = this.sim.s;
    const meter = (v: number, max = 100) => `<span class="meter"><div style="width:${Math.round((v / max) * 100)}%"></div></span>`;
    if (this.openPanel === "jobs") {
      p.innerHTML = `<h3>CONTRACTS — hands-on work at gold beacons</h3>`;
      for (const c of CONTRACTS.filter((x) => x.minAct <= s.act || s.empireMode)) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span><b>${c.name}</b> <span class="muted">Tier ${c.tier} — $${c.reward} +${c.rep} rep — ${c.workTime}s work</span><br><span class="muted">${c.desc}</span></span>`;
        const b = document.createElement("button");
        b.textContent = "Take job";
        b.onclick = () => { this.actions.startJob(c.id); this.closePanel(); this.toast(`${c.name}: go to a gold beacon, press E.`); };
        row.appendChild(b);
        p.appendChild(row);
      }
    } else if (this.openPanel === "bank") {
      p.innerHTML = `<h3>EMPIRE BANK — shared by the crew</h3>
        <div class="row"><span>Wallet <b>$${Math.floor(s.wallet).toLocaleString()}</b></span><span>Bank <b>$${Math.floor(s.bank).toLocaleString()}</b></span></div>
        <div class="row"><span class="muted">Fixed deposit limit: $${DEPOSIT_LIMIT.toLocaleString()} per deposit. Identical for every player — rank never raises it.</span></div>
        <div class="row"><span>Mission: pay $2,000 tribute — $${s.missions["a5m3"] ?? 0}/$2,000</span></div>`;
      const mkRow = (label: string, fn: (n: number) => OpResult) => {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span>${label}</span>`;
        const inp = document.createElement("input");
        inp.type = "number"; inp.min = "1"; inp.value = "1000"; inp.style.width = "110px";
        const b = document.createElement("button");
        b.textContent = "OK";
        b.onclick = () => { const n = Math.floor(Number(inp.value)); if (isFinite(n)) this.handle(fn(n)); };
        row.appendChild(inp); row.appendChild(b);
        p.appendChild(row);
      };
      mkRow("Deposit to empire", (n) => this.actions.deposit(n));
      mkRow("Withdraw to wallet", (n) => this.actions.withdraw(n));
      mkRow("Pay tribute (Pale Ledger)", (n) => this.actions.payTribute(n));
      const sv = document.createElement("div");
      sv.className = "row";
      sv.innerHTML = `<span class="muted">Saves to this machine (localStorage).</span>`;
      const sb = document.createElement("button"); sb.textContent = "Save now";
      sb.onclick = () => { this.actions.save(); this.toast("Saved."); };
      const nb = document.createElement("button"); nb.textContent = "New game"; nb.className = "danger";
      nb.onclick = () => this.modal("<h2>Start over?</h2><div>Erases wallet, empire, story and city progress on this machine.</div>",
        [{ label: "Erase + restart", fn: () => this.actions.newGame() }, { label: "Cancel", fn: () => undefined }]);
      sv.appendChild(sb); sv.appendChild(nb);
      p.appendChild(sv);
    } else if (this.openPanel === "props") {
      p.innerHTML = `<h3>PROPERTIES — shared empire assets</h3>`;
      for (const d of PROPERTIES) {
        const lv = s.props[d.id] ?? 0;
        const locked = s.act < d.minAct && !s.empireMode;
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span><b>${d.name}</b> ${locked ? '<span class="muted">(unlocks later)</span>' : lv === 0 ? `<span class="muted">— $${d.cost.toLocaleString()}</span>` : `<span class="muted">— Lv${lv}/3, $${(d.incomePerSec * lv).toFixed(1)}/s</span>`}<br><span class="muted">${d.desc}</span></span>`;
        if (!locked) {
          if (lv === 0) {
            const b = document.createElement("button");
            b.textContent = "Buy (empire)";
            b.onclick = () => this.handle(this.actions.buyProperty(d.id, false), () => this.actions.buyProperty(d.id, true));
            row.appendChild(b);
          } else if (lv < 3) {
            const b = document.createElement("button");
            b.textContent = `Renovate $${(d.upgradeCost * lv).toLocaleString()}`;
            b.onclick = () => this.handle(this.actions.upgradeProperty(d.id, false), () => this.actions.upgradeProperty(d.id, true));
            row.appendChild(b);
          }
        }
        p.appendChild(row);
        if (lv > 0) {
          const stashRow = document.createElement("div");
          stashRow.className = "row";
          const stashed = s.stash[d.id] ?? 0;
          stashRow.innerHTML = `<span class="muted">↳ Stash at ${d.name}: <b>$${stashed.toLocaleString()}</b> (safe from busts)</span>`;
          const inp = document.createElement("input");
          inp.type = "number"; inp.min = "1"; inp.value = "500"; inp.style.width = "90px";
          const bin = document.createElement("button");
          bin.textContent = "Stash";
          bin.onclick = () => { const n = Math.floor(Number(inp.value)); if (isFinite(n)) this.handle(this.actions.stashCash(d.id, n)); };
          const bout = document.createElement("button");
          bout.textContent = "Take";
          bout.onclick = () => { const n = Math.floor(Number(inp.value)); if (isFinite(n)) this.handle(this.actions.unstashCash(d.id, n)); };
          stashRow.appendChild(inp); stashRow.appendChild(bin); stashRow.appendChild(bout);
          p.appendChild(stashRow);
        }
      }
    } else if (this.openPanel === "cars") {
      p.innerHTML = `<h3>GARAGE — empire vehicles are shared; personal ones are yours alone</h3>
        <div class="row"><span class="muted">Owned: ${s.vehicles.length === 0 ? "none yet" : s.vehicles.map((v) => `${v.id} (${v.owner})`).join(", ")}</span></div>
        <div class="row"><span class="muted">A drivable work truck is parked near the plaza — walk to it and press E. Owned vehicles boost drive speed.</span></div>`;
      for (const v of VEHICLES) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span><b>${v.name}</b> <span class="muted">${v.kind} — $${v.cost.toLocaleString()} — +${v.speedBonus} speed</span></span>`;
        const be = document.createElement("button");
        be.textContent = "Buy (empire)";
        be.onclick = () => this.handle(this.actions.buyVehicle(v.id, "empire", false), () => this.actions.buyVehicle(v.id, "empire", true));
        const bp = document.createElement("button");
        bp.textContent = "Buy (personal)";
        bp.onclick = () => this.handle(this.actions.buyVehicle(v.id, "player", false), () => this.actions.buyVehicle(v.id, "player", true));
        row.appendChild(be); row.appendChild(bp);
        p.appendChild(row);
      }
    } else if (this.openPanel === "people") {
      p.innerHTML = `<h3>PEOPLE — talk (E) near gold-name NPCs to build relationships</h3>`;
      for (const n of NPCS) {
        const rel = s.rel[n.id] ?? 0;
        const emp = s.employees.find((e) => e.npcId === n.id);
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span><b>${n.name}</b> <span class="muted">${n.role}, ${n.district}</span><br><span class="muted">${relStage(rel)} (${rel}) ${emp ? `— EMPLOYED, ${emp.assigned ? "at " + emp.assigned : "reserve"}, paid $${emp.salary}/min` : n.recruitable ? "— recruitable at 70" : ""}</span></span>`;
        if (emp) {
          const sel = document.createElement("select");
          const opts = ["", "streets", ...PROPERTIES.filter((x) => (s.props[x.id] ?? 0) > 0).map((x) => x.id)];
          for (const o of opts) {
            const op = document.createElement("option");
            op.value = o;
            op.textContent = o === "" ? "Reserve" : o === "streets" ? "Streets (runner — sells stock for you, 20% cut)" : o;
            if (emp.assigned === o || (!emp.assigned && o === "")) op.selected = true;
            sel.appendChild(op);
          }
          sel.onchange = () => this.handle(this.actions.assign(n.id, sel.value === "" ? null : sel.value));
          row.appendChild(sel);
        }
        p.appendChild(row);
      }
      p.innerHTML += `<h3>CUSTOMERS</h3>`;
      for (const c of CUSTOMERS) {
        const sat = s.sat[c.id] ?? 50;
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span><b>${c.name}</b> <span class="muted">${c.personality} — wants ${c.preferredQuality} ~$${c.preferredPrice}, ${c.priceSensitivity} sensitivity</span><br><span class="muted">${satLabel(sat)} (${sat})</span></span>`;
        const m = document.createElement("span");
        m.innerHTML = meter(sat);
        row.appendChild(m);
        p.appendChild(row);
      }
      p.innerHTML += `<h3>FACTIONS</h3>`;
      for (const f of FACTIONS) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span><b>${f.name}</b> <span class="muted">${f.desc}</span></span><span>${s.factions[f.id] ?? 0}</span>`;
        p.appendChild(row);
      }
    } else if (this.openPanel === "biz") {
      const unlocked = s.act >= 3 || s.empireMode;
      p.innerHTML = `<h3>BACKROOM — fictional goods, abstract batches</h3>`;
      if (!unlocked) {
        p.innerHTML += `<div class="row"><span class="muted">Meet Vesper Quill on Mercer Row (Act 3) to open the backroom.</span></div>`;
      } else {
        p.innerHTML += `<div class="row"><span class="muted">Refining needs a warehouse or factory + materials. Each sale raises Heat — cool it by laying low.</span></div>`;
        const sup = document.createElement("div");
        sup.className = "row";
        sup.innerHTML = `<span><b>Supplier</b> <span class="muted">Materials: ${s.materials}u — $10/u${s.employees.some((e) => e.npcId === "odell") ? " ($8 with Odell)" : ""}</span></span>`;
        const sinp = document.createElement("input");
        sinp.type = "number"; sinp.min = "1"; sinp.value = "8"; sinp.style.width = "70px";
        const sb = document.createElement("button");
        sb.textContent = "Buy";
        sb.onclick = () => { const n = Math.floor(Number(sinp.value)); if (isFinite(n)) this.handle(this.actions.buyMaterials(n)); };
        sup.appendChild(sinp); sup.appendChild(sb);
        p.appendChild(sup);
        for (const prod of PRODUCTS) {
          const row = document.createElement("div");
          row.className = "row";
          row.innerHTML = `<span><b>${prod.name}</b> <span class="muted">${prod.desc} (ref ~$${prod.basePrice}/u NORMAL)</span></span>`;
          for (const q of ["POOR", "NORMAL", "PREMIUM"] as Quality[]) {
            const b = document.createElement("button");
            b.textContent = q;
            b.onclick = () => this.handle(this.actions.produce(prod.id, q));
            row.appendChild(b);
          }
          p.appendChild(row);
        }
        p.innerHTML += `<h3>BLENDING BENCH</h3>`;
        if (s.stock.length === 0) {
          p.innerHTML += `<div class="row"><span class="muted">No batches to blend.</span></div>`;
        } else {
          const b0 = s.stock[0];
          for (const a of ADDITIVES) {
            const row = document.createElement("div");
            row.className = "row";
            row.innerHTML = `<span class="muted">Oldest: ${b0.units}u ${b0.label} (${b0.quality}) + <b>${a.name}</b> — ${a.desc}</span>`;
            const nameInp = document.createElement("input");
            nameInp.placeholder = "Blend name";
            nameInp.maxLength = 18;
            nameInp.style.width = "110px";
            const bb = document.createElement("button");
            bb.textContent = "Blend";
            bb.onclick = () => this.handle(this.actions.mixBatch(0, a.id, nameInp.value));
            row.appendChild(nameInp); row.appendChild(bb);
            p.appendChild(row);
          }
        }
        p.innerHTML += `<h3>STOCK & SALES</h3>`;
        if (s.stock.length === 0) p.innerHTML += `<div class="row"><span class="muted">No stock. Refine a batch first.</span></div>`;
        s.stock.forEach((b, i) => {
          const row = document.createElement("div");
          row.className = "row";
          row.innerHTML = `<span><b>${b.units}u ${b.label} (${b.quality})</b></span>`;
          for (const c of CUSTOMERS) {
            const btn = document.createElement("button");
            btn.textContent = `Sell to ${c.name.split(" ")[0]} @$${c.preferredPrice}`;
            btn.onclick = () => this.handle(this.actions.sell(c.id, i, c.preferredPrice));
            row.appendChild(btn);
          }
          p.appendChild(row);
        });
      }
    } else if (this.openPanel === "you") {
      p.innerHTML = `<h3>${s.character.name.toUpperCase()} — no fixed roles, train anything</h3>
        <div class="row"><span class="muted">Wallet $${Math.floor(s.wallet).toLocaleString()} — earned total $${Math.floor(s.stats.earned).toLocaleString()} — contracts ${s.stats.contracts} — sales ${s.stats.sales}</span></div>`;
      for (const k of Object.keys(s.skills) as (keyof typeof s.skills)[]) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span>${k} <b>Lv${s.skills[k]}</b></span>`;
        const m = document.createElement("span");
        m.innerHTML = meter(s.xp[k], s.skills[k] * 100);
        row.appendChild(m);
        p.appendChild(row);
      }
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="muted">Materials: ${s.materials} — Crates: ${s.crates}</span>`;
      p.appendChild(row);
    } else if (this.openPanel === "lobby") {
      p.innerHTML = `<h3>LOBBY — you host, friends join you (up to 4)</h3>
        <div class="row"><span class="muted">No servers, no accounts. Host: create a code, send it to a friend. Friend: paste it, send the answer back. Same LAN or internet.</span></div>
        <div class="row"><span id="lob-msg" class="muted">${this.lobbyMsg || "Offline — solo crew."}</span></div>`;
      const call = (op: string, payload: string, okMsg?: (r: string) => void) => {
        this.actions.lobby(op, payload).then((r) => {
          if (op === "invite") this.inviteCode = r;
          if (okMsg) okMsg(r);
          this.lobbyMsg = r.slice(0, 120);
          this.refresh();
        }).catch((e: unknown) => {
          this.lobbyMsg = "Error: " + (e instanceof Error ? e.message : String(e));
          this.refresh();
        });
      };
      const nameRow = document.createElement("div");
      nameRow.className = "row";
      nameRow.innerHTML = `<span>Your name</span>`;
      const nameInp = document.createElement("input");
      nameInp.value = this.lobbyName || s.character.name;
      nameInp.maxLength = 16;
      nameInp.style.width = "130px";
      nameInp.onchange = () => { this.lobbyName = nameInp.value; };
      nameRow.appendChild(nameInp);
      p.appendChild(nameRow);

      const hostRow = document.createElement("div");
      hostRow.className = "row";
      hostRow.innerHTML = `<span><b>Host</b> <span class="muted">— your machine is the server</span></span>`;
      const hi = document.createElement("button");
      hi.textContent = "Host game";
      hi.onclick = () => call("host", nameInp.value, () => { this.lobbyMsg = "Hosting. Create an invite code below."; });
      const inv = document.createElement("button");
      inv.textContent = "Create invite code";
      inv.onclick = () => call("invite", "", () => undefined);
      hostRow.appendChild(hi); hostRow.appendChild(inv);
      p.appendChild(hostRow);
      if (this.inviteCode) {
        const codeRow = document.createElement("div");
        codeRow.className = "row";
        codeRow.innerHTML = `<span class="muted">Send this to your friend:</span>`;
        const ta = document.createElement("input");
        ta.value = this.inviteCode;
        ta.readOnly = true;
        ta.style.width = "200px";
        ta.onclick = () => ta.select();
        const ans = document.createElement("input");
        ans.placeholder = "paste friend answer";
        ans.style.width = "150px";
        const ab = document.createElement("button");
        ab.textContent = "Accept";
        ab.onclick = () => call("accept", ans.value, () => { this.lobbyMsg = "Guest accepted."; });
        codeRow.appendChild(ta); codeRow.appendChild(ans); codeRow.appendChild(ab);
        p.appendChild(codeRow);
      }
      const joinRow = document.createElement("div");
      joinRow.className = "row";
      joinRow.innerHTML = `<span><b>Join</b></span>`;
      const jin = document.createElement("input");
      jin.placeholder = "paste host code";
      jin.style.width = "150px";
      const jb = document.createElement("button");
      jb.textContent = "Join";
      jb.onclick = () => {
        this.lobbyName = nameInp.value;
        call("join", JSON.stringify({ code: jin.value, name: nameInp.value }), (r) => {
          this.joinCode = r;
          this.lobbyMsg = "Joined! Send this answer back to the host:";
        });
      };
      joinRow.appendChild(jin); joinRow.appendChild(jb);
      p.appendChild(joinRow);
      if (this.joinCode) {
        const aRow = document.createElement("div");
        aRow.className = "row";
        aRow.innerHTML = `<span class="muted">Your answer for the host:</span>`;
        const ta = document.createElement("input");
        ta.value = this.joinCode;
        ta.readOnly = true;
        ta.style.width = "200px";
        ta.onclick = () => ta.select();
        aRow.appendChild(ta);
        p.appendChild(aRow);
      }
      const lv = document.createElement("div");
      lv.className = "row";
      lv.innerHTML = `<span class="muted">If the host quits, the session ends (no migration yet).</span>`;
      const lb = document.createElement("button");
      lb.textContent = "Leave / go offline";
      lb.onclick = () => {
        this.inviteCode = ""; this.joinCode = "";
        call("leave", "", () => { this.lobbyMsg = "Offline."; });
      };
      lv.appendChild(lb);
      p.appendChild(lv);
    } else if (this.openPanel === "settings") {
      p.innerHTML = `<h3>SETTINGS — per player, never affects others</h3>`;
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span>Quality preset</span>`;
      for (const q of ["Low", "Medium", "High", "Ultra"] as Settings["preset"][]) {
        const b = document.createElement("button");
        b.textContent = q;
        b.onclick = () => { this.settings.preset = q; this.actions.applySettings(this.settings); this.render(); };
        if (this.settings.preset === q) b.style.borderColor = "#fbbf24";
        row.appendChild(b);
      }
      p.appendChild(row);
      const mkToggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
        const r = document.createElement("div");
        r.className = "row";
        r.innerHTML = `<span>${label}: <b>${get() ? "ON" : "OFF"}</b></span>`;
        const b = document.createElement("button");
        b.textContent = "Toggle";
        b.onclick = () => { set(!get()); this.actions.applySettings(this.settings); this.render(); };
        r.appendChild(b);
        p.appendChild(r);
      };
      mkToggle("Fullscreen", () => this.settings.fullscreen, (v) => { this.settings.fullscreen = v; });
      mkToggle("Music", () => this.settings.music, (v) => { this.settings.music = v; });
      const vr = document.createElement("div");
      vr.className = "row";
      vr.innerHTML = `<span>Volume</span>`;
      const inp = document.createElement("input");
      inp.type = "range"; inp.min = "0"; inp.max = "100"; inp.value = String(Math.round(this.settings.volume * 100));
      inp.onchange = () => { this.settings.volume = Number(inp.value) / 100; this.actions.applySettings(this.settings); };
      vr.appendChild(inp);
      p.appendChild(vr);
      const gp = document.createElement("div");
      gp.className = "row";
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean).length : 0;
      gp.innerHTML = `<span class="muted">Controller: ${pads > 0 ? pads + " connected (left stick moves, A jumps)" : "none detected — keyboard + mouse ready"}</span>`;
      p.appendChild(gp);
    } else if (this.openPanel === "help") {
      p.innerHTML = `<h3>HOW TO PLAY — street loop</h3>
        <div class="row"><span><b>WASD</b> move · <b>Space</b> jump · <b>drag mouse</b> orbit camera · <b>E</b> interact · <b>F</b> first/third person · <b>R</b> reset position</span></div>
        <div class="row"><span>Day/night cycle runs in the top bar. At <b>night</b>, buyers walk the streets — walk up, press <b>E</b>, sell fair or haggle.</span></div>
        <div class="row"><span>Refine batches in <b>Biz</b> (needs materials + warehouse/factory), <b>blend</b> them at the bench, stash cash in <b>Props</b> — stashes survive busts.</span></div>
        <div class="row"><span>High <b>Heat</b> brings <b>Warden patrols</b>: outrun them or get busted (lose carried stock + 25% wallet). Assign crew to <b>Streets</b> in People to run product for you.</span></div>
        <div class="row"><span>Take <b>Jobs</b>, work gold beacons, deposit (fixed $${DEPOSIT_LIMIT.toLocaleString()} limit), buy the empire up through 6 acts into endless <b>EMPIRE MODE</b>.</span></div>
        <div class="row"><span class="muted">Single-player milestone build. The sim is one serializable EmpireSim; online multiplayer is a future milestone, not included.</span></div>`;
    }
  }
}
