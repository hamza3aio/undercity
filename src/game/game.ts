import { Engine } from "../core/engine.js";
import { Vec3 } from "../math/vec3.js";
import { CharacterController } from "../physics/character.js";
import { InputActions } from "../input/actions.js";
import { makeRigidbody, makeTransform, type MeshRef, type Rigidbody, type Transform } from "../ecs/components.js";
import type { Entity } from "../ecs/world.js";
import { EmpireSim, type OpResult } from "./sim/sim.js";
import { CONTRACTS, type Quality } from "./data/world.js";
import { buildCity, districtAt, syncPropertyVisuals, NPC_SPOTS, type CityRefs } from "./world/city.js";
import { GameUI, type Settings, type UIActions } from "./ui/ui.js";

const SAVE_POS_KEY = "undercity-pos-v1";

export class Game implements UIActions {
  private engine: Engine;
  private sim = new EmpireSim();
  private ui: GameUI;
  private city!: CityRefs;
  private player!: Entity;
  private hat: Entity | null = null;
  private carryCrate: Entity | null = null;
  private actions = new InputActions(null as never);
  private walker = new CharacterController({ speed: 6, jumpSpeed: 8, acceleration: 40 });
  private driver = new CharacterController({ speed: 10, jumpSpeed: 4, acceleration: 25 });
  private activeJob: string | null = null;
  private carrying = false;
  private driving = false;
  private channel: { label: string; t: number; dur: number; ax: number; az: number; radius: number; onDone: () => void } | null = null;
  private hudTimer = 0;
  private saveTimer = 0;
  private scanTimer = 0;
  private nearbyNPC: string | null = null;
  private nearbyBeacon = false;
  private nearbyTruck = false;
  private nearbyCrates = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas);
    this.ui = new GameUI(this.sim, this);
    this.actions = new InputActions(this.engine.input);
  }

  boot() {
    const loaded = this.sim.load();
    this.city = buildCity(this.engine.world);
    this.spawnPlayer();
    syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
    this.applyAvatar();
    this.restorePos();

    this.sim.onEvent = () => this.ui.refreshLog();
    this.ui.refreshLog();
    this.applySettings(this.ui.settings);

    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyE" && !e.repeat && (e.target as HTMLElement).tagName !== "INPUT") this.interact();
    });

    this.engine.addSystem((dt) => this.update(dt));
    this.engine.start();

    if (!this.sim.s.customized) this.ui.characterCreation();
    else this.ui.toast(loaded ? `Welcome back, ${this.sim.s.character.name}.` : `Welcome, ${this.sim.s.character.name}. Follow the objective (top-left).`);
  }

  // ---------- UIActions ----------
  deposit(n: number): OpResult { return this.sim.deposit(n); }
  withdraw(n: number): OpResult { return this.sim.withdraw(n); }
  buyProperty(id: string, c: boolean): OpResult {
    const r = this.sim.buyProperty(id, c);
    if (r.ok) syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
    return r;
  }
  upgradeProperty(id: string, c: boolean): OpResult {
    const r = this.sim.upgradeProperty(id, c);
    if (r.ok) syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
    return r;
  }
  buyVehicle(id: string, owner: "empire" | "player", c: boolean): OpResult { return this.sim.buyVehicle(id, owner, c); }
  produce(p: string, q: Quality): OpResult { return this.sim.produce(p, q); }
  sell(c: string, b: number, price: number): OpResult { return this.sim.sellTo(c, b, price); }
  talk(n: string, ch: number): OpResult { return this.sim.talk(n, ch); }
  recruit(n: string): OpResult { return this.sim.recruit(n); }
  assign(n: string, p: string | null): OpResult { return this.sim.assignEmployee(n, p); }
  payTribute(n: number): OpResult { return this.sim.payTribute(n); }
  startJob(id: string): void { this.activeJob = id; }
  setCharacter(name: string, body: [number, number, number], accent: [number, number, number], hat: boolean): void {
    this.sim.s.character = { name, body, accent, hat };
    this.sim.s.customized = true;
    this.sim.log(`${name} takes charge of the crew.`);
    this.applyAvatar();
    this.sim.save();
  }
  save(): void { this.savePos(); this.sim.save(); }
  newGame(): void {
    try { localStorage.removeItem("undercity-save-v1"); localStorage.removeItem(SAVE_POS_KEY); } catch { /* fresh start anyway */ }
    location.reload();
  }
  applySettings(s: Settings): void {
    const far = s.preset === "Low" ? 40 : s.preset === "Medium" ? 70 : s.preset === "High" ? 100 : 140;
    this.engine.renderer.camera.far = far;
    if (s.preset === "Low") this.engine.renderer.pointLights.length = 0;
    else if (this.engine.renderer.pointLights.length === 0) {
      this.engine.renderer.pointLights.push({ position: new Vec3(0, 8, 0), color: [1.0, 0.85, 0.6], intensity: 0.8, range: 30 });
    }
    if (s.fullscreen && document.fullscreenElement == null) void document.documentElement.requestFullscreen().catch(() => undefined);
    if (!s.fullscreen && document.fullscreenElement != null) void document.exitFullscreen().catch(() => undefined);
    this.engine.audio.setVolume(s.volume);
    if (s.music) this.engine.audio.startMusic();
    else this.engine.audio.stopMusic();
  }

  // ---------- setup ----------
  private spawnPlayer() {
    const world = this.engine.world;
    const e = world.create();
    const t = makeTransform(0, 2, 6);
    t.scale.set(0.9, 1.5, 0.9);
    world.add(e, "transform", t);
    world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [0.2, 0.5, 1.0] });
    world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    world.add(e, "rigidbody", makeRigidbody(true, 1));
    this.player = e;
  }

  private applyAvatar() {
    const world = this.engine.world;
    const m = world.get<MeshRef>(this.player, "mesh");
    if (m) { m.color = [...this.sim.s.character.body] as [number, number, number]; }
    if (this.hat !== null) { world.destroy(this.hat); this.hat = null; }
    if (this.sim.s.character.hat) {
      const h = world.create();
      world.add(h, "transform", makeTransform(0, 0, 0));
      world.add<MeshRef>(h, "mesh", { meshId: "cube", color: [...this.sim.s.character.accent] as [number, number, number] });
      const ht = world.get<Transform>(h, "transform")!;
      ht.scale.set(1.0, 0.25, 1.0);
      this.hat = h;
    }
    this.engine.renderer.pointLights.push({ position: new Vec3(0, 6, 6), color: this.sim.s.character.accent, intensity: 0.5, range: 18 });
  }

  private savePos() {
    try {
      const t = this.engine.world.get<Transform>(this.player, "transform")!;
      localStorage.setItem(SAVE_POS_KEY, JSON.stringify([t.position.x, t.position.y, t.position.z]));
    } catch { /* storage unavailable */ }
  }

  private restorePos() {
    try {
      const raw = localStorage.getItem(SAVE_POS_KEY);
      if (!raw) return;
      const [x, y, z] = JSON.parse(raw) as [number, number, number];
      const t = this.engine.world.get<Transform>(this.player, "transform")!;
      const rb = this.engine.world.get<Rigidbody>(this.player, "rigidbody")!;
      if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 60 && Math.abs(z) < 60) {
        t.position.set(x, Math.max(1, y), z);
        rb.velocity.set(0, 0, 0);
      }
    } catch { /* start at spawn */ }
  }

  // ---------- interaction ----------
  private playerPos(): Vec3 {
    return this.engine.world.get<Transform>(this.player, "transform")!.position;
  }

  private scan() {
    const p = this.playerPos();
    this.nearbyNPC = null;
    let best = 3.2;
    for (const [id, spot] of Object.entries(NPC_SPOTS)) {
      const d = Math.hypot(p.x - spot[0], p.z - spot[1]);
      if (d < best) { best = d; this.nearbyNPC = id; }
    }
    this.nearbyBeacon = Object.values(this.city.beacons).some((b) => {
      const t = this.engine.world.get<Transform>(b, "transform")!;
      return Math.hypot(p.x - t.position.x, p.z - t.position.z) < 3.5;
    });
    const tt = this.engine.world.get<Transform>(this.city.truck, "transform")!;
    this.nearbyTruck = Math.hypot(p.x - tt.position.x, p.z - tt.position.z) < 3.5;
    const ct = this.engine.world.get<Transform>(this.city.cratePile, "transform")!;
    this.nearbyCrates = Math.hypot(p.x - ct.position.x, p.z - ct.position.z) < 3.0;

    if (this.driving) this.ui.showPrompt(`<kbd>E</kbd> Exit truck`);
    else if (this.nearbyNPC) this.ui.showPrompt(`<kbd>E</kbd> Talk to ${this.nearbyNPC}`);
    else if (this.nearbyBeacon && this.carrying) this.ui.showPrompt(`<kbd>E</kbd> Deliver crate (+$120)`);
    else if (this.nearbyBeacon && this.activeJob) this.ui.showPrompt(`<kbd>E</kbd> Work: ${CONTRACTS.find((c) => c.id === this.activeJob)?.name}`);
    else if (this.nearbyBeacon) this.ui.showPrompt(`Pick a <b>Job</b> first (J), then work here`);
    else if (this.nearbyTruck) this.ui.showPrompt(`<kbd>E</kbd> Drive work truck`);
    else if (this.nearbyCrates && !this.carrying) this.ui.showPrompt(`<kbd>E</kbd> Load crate (needs warehouse)`);
    else this.ui.showPrompt(null);
  }

  private interact() {
    if (this.driving) { this.exitTruck(); return; }
    if (this.nearbyNPC) { this.ui.talkDialog(this.nearbyNPC); return; }
    if (this.nearbyBeacon && this.carrying) { this.deliver(); return; }
    if (this.nearbyBeacon && this.activeJob) { this.startWork(); return; }
    if (this.nearbyTruck) { this.enterTruck(); return; }
    if (this.nearbyCrates && !this.carrying) { this.pickupCrate(); return; }
  }

  private startWork() {
    const def = CONTRACTS.find((c) => c.id === this.activeJob);
    if (!def) return;
    const p = this.playerPos();
    this.channel = {
      label: `Working: ${def.name}… stay at the beacon`,
      t: 0, dur: def.workTime, ax: p.x, az: p.z, radius: 3.5,
      onDone: () => {
        const r = this.sim.completeContract(def.id);
        this.engine.audio.pickup();
        this.ui.toast(r.msg);
        if (this.sim.s.act === 5 && (def.id === "commercial" || def.id === "development")) {
          this.sim.bumpMission("defend", undefined, 1);
        }
        this.activeJob = null;
        this.ui.refresh();
      },
    };
  }

  private pickupCrate() {
    if ((this.sim.s.props["warehouse"] ?? 0) === 0) {
      this.ui.toast("Buy the Dockside Warehouse first (Props menu).");
      return;
    }
    this.carrying = true;
    const e = this.engine.world.create();
    this.engine.world.add(e, "transform", makeTransform(0, 0, 0));
    this.engine.world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [0.6, 0.45, 0.25] });
    const t = this.engine.world.get<Transform>(e, "transform")!;
    t.scale.set(0.6, 0.6, 0.6);
    this.carryCrate = e;
    this.engine.audio.blip(300, 0.1, "square", 0.05);
  }

  private deliver() {
    this.carrying = false;
    if (this.carryCrate !== null) { this.engine.world.destroy(this.carryCrate); this.carryCrate = null; }
    this.sim.earn(120, "crate delivery");
    this.sim.gainXp("logistics", 14);
    this.sim.gainXp("driving", 6);
    this.engine.audio.pickup();
    this.ui.toast("Delivered +$120.");
  }

  private enterTruck() {
    this.driving = true;
    this.engine.audio.blip(220, 0.15, "sawtooth", 0.06);
    this.ui.toast("Driving — WASD + Space brake-jump. E to exit.");
  }

  private exitTruck() {
    this.driving = false;
    const tt = this.engine.world.get<Transform>(this.city.truck, "transform")!;
    const pt = this.engine.world.get<Transform>(this.player, "transform")!;
    const prb = this.engine.world.get<Rigidbody>(this.player, "rigidbody")!;
    pt.position.set(tt.position.x + 2.5, tt.position.y + 1, tt.position.z);
    prb.velocity.set(0, 0, 0);
  }

  // ---------- per-frame ----------
  private readPad(): { x: number; z: number; jump: boolean } {
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        const dz = (v: number) => (Math.abs(v) > 0.2 ? v : 0);
        return { x: dz(gp.axes[0] ?? 0), z: -dz(gp.axes[1] ?? 0), jump: !!(gp.buttons[0]?.pressed) };
      }
    } catch { /* no gamepad */ }
    return { x: 0, z: 0, jump: false };
  }

  private update(dt: number) {
    const world = this.engine.world;
    this.sim.tick(dt);

    // movement
    const pad = this.readPad();
    const move = this.actions.move();
    const mx = Math.max(-1, Math.min(1, move.x + pad.x));
    const mz = Math.max(-1, Math.min(1, move.z + pad.z));
    const yaw = this.engine.renderer.camera.yaw;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const wishX = mx * cos - mz * sin;
    const wishZ = -mz * cos - mx * sin;
    const jump = this.actions.jump() || pad.jump;

    if (this.driving) {
      const tt = world.get<Transform>(this.city.truck, "transform")!;
      const trb = world.get<Rigidbody>(this.city.truck, "rigidbody")!;
      const bonus = this.sim.s.vehicles.reduce((a, v) => a + 0.15, 0);
      void bonus;
      this.driver.move(tt, trb, wishX, wishZ, false, dt);
      tt.rotationY = yaw + Math.PI;
      const pt = world.get<Transform>(this.player, "transform")!;
      const prb = world.get<Rigidbody>(this.player, "rigidbody")!;
      pt.position.set(tt.position.x, tt.position.y + 1.2, tt.position.z);
      prb.velocity.set(0, 0, 0);
      this.engine.renderer.camera.follow(tt.position);
    } else {
      const t = world.get<Transform>(this.player, "transform")!;
      const rb = world.get<Rigidbody>(this.player, "rigidbody")!;
      const wasAir = !rb.grounded;
      this.walker.move(t, rb, wishX, wishZ, jump, dt, () => this.engine.audio.jump());
      if (wasAir && rb.grounded) this.engine.audio.land();
      if (this.actions.reset()) {
        t.position.set(0, 2, 6);
        rb.velocity.set(0, 0, 0);
      }
      // face movement
      if (Math.abs(wishX) + Math.abs(wishZ) > 0.1) t.rotationY = Math.atan2(wishX, wishZ);
      // hat + crate follow
      if (this.hat !== null) {
        const ht = world.get<Transform>(this.hat, "transform")!;
        ht.position.set(t.position.x, t.position.y + t.scale.y * 0.5 + 0.2, t.position.z);
        ht.rotationY = t.rotationY;
      }
      if (this.carryCrate !== null) {
        const ct = world.get<Transform>(this.carryCrate, "transform")!;
        ct.position.set(t.position.x, t.position.y + 0.4, t.position.z + 0.8);
      }
      this.engine.renderer.camera.follow(t.position);
    }

    const drag = this.engine.input.consumeDrag();
    this.engine.renderer.camera.updateOrbit(drag.dx, drag.dy);

    // work channel
    if (this.channel) {
      const p = this.playerPos();
      const moved = Math.hypot(p.x - this.channel.ax, p.z - this.channel.az) > this.channel.radius;
      if (moved) {
        this.channel = null;
        this.ui.channel(null, 0);
        this.ui.toast("Work interrupted — stay at the beacon.");
      } else {
        this.channel.t += dt;
        this.ui.channel(this.channel.label, this.channel.t / this.channel.dur);
        if (this.channel.t >= this.channel.dur) {
          const done = this.channel.onDone;
          this.channel = null;
          this.ui.channel(null, 0);
          done();
        }
      }
    }

    // scans + HUD @ ~5Hz
    this.scanTimer += dt;
    if (this.scanTimer > 0.2) { this.scanTimer = 0; this.scan(); }

    this.ui.district = districtAt(this.playerPos().x, this.playerPos().z);
    this.hudTimer += dt;
    if (this.hudTimer > 0.25) {
      this.hudTimer = 0;
      this.ui.refreshTop();
      const cur = this.sim.currentMissions()[0];
      if (cur) {
        const prog = this.sim.missionProgress(cur);
        this.ui.setObjective(
          this.sim.s.empireMode ? "EMPIRE MODE — endless" : `ACT ${cur.act}/6 — ${["", "NOBODY", "CONTRACTORS", "THE UNDERGROUND", "EMPIRE", "EMPIRE WAR", "KING OF THE CITY"][cur.act]}`,
          cur.title, cur.desc, prog.text);
      } else {
        this.ui.setObjective("EMPIRE MODE — endless", "The city is yours", "Expand, trade, recruit. Dynamic events continue.", "");
      }
      this.ui.refreshLog();
    }

    // autosave
    this.saveTimer += dt;
    if (this.saveTimer > 30) { this.saveTimer = 0; this.savePos(); this.sim.save(); }
  }
}
