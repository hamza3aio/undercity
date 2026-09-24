import { Engine } from "../core/engine.js";
import { LoadingScreen, nextFrame } from "../core/loading.js";
import { Vec3 } from "../math/vec3.js";
import { CharacterController } from "../physics/character.js";
import { InputActions } from "../input/actions.js";
import { P2PNet, type RemotePlayer } from "../net/p2p.js";
import { makeRigidbody, makeTransform, type MeshRef, type Rigidbody, type Transform } from "../ecs/components.js";
import type { Entity } from "../ecs/world.js";
import { EmpireSim, fairFor, type OpResult, type SimState } from "./sim/sim.js";
import { CONTRACTS, CUSTOMERS, type Quality } from "./data/world.js";
import { BUST_IMMUNITY, PATROL_GIVEUP, PATROL_MIN_HEAT, PATROL_SPEED, isNightHour } from "./data/street.js";
import { buildCity, districtAt, syncPropertyVisuals, NPC_SPOTS, type CityRefs } from "./world/city.js";
import { buildActor, poseActor, restoreRigMesh, setRigMesh, type ActorRig } from "../scene/actor.js";
import { hideBlob, makeBlob, stickBlob } from "../rendering/shadows.js";
import { paintAsphalt, paintBrick, paintGrass, paintRoof, paintSign, paintWater } from "../rendering/proctex.js";
import type { C3 } from "../rendering/proctex.js";
import { skyAt } from "../rendering/sky.js";
import { GameUI, type Settings, type UIActions } from "./ui/ui.js";
import { MainMenu } from "./ui/menu.js";

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
  private nearbyBench = false;
  private nearbyWalker = -1;
  private fp = false;
  private menuMode = true;
  private menu!: MainMenu;
  private loader = new LoadingScreen();
  private net = new P2PNet();
  private remotes = new Map<string, { rig: ActorRig; blob: Entity; phase: number; x: number; z: number }>();
  private snapTimer = 0;
  private posTimer = 0;
  private immunityT = 0;
  private warnedPatrol = false;
  private walkPhase = 0;
  private shakeT = 0;
  private stars: Entity[] = [];
  private rig: ActorRig | null = null;
  private rigHidden = new Map<Entity, string>();
  private npcRigs: { id: string; rig: ActorRig; x: number; z: number; ry: number }[] = [];
  private walkerRigs: ActorRig[] = [];
  private walkerPhase: number[] = [];
  private patrolRigs: ActorRig[] = [];
  private patrolPhase: number[] = [0, 0];
  private blobHero!: Entity;
  private blobTruck!: Entity;
  private walkerBlobs: Entity[] = [];
  private patrolBlobs: Entity[] = [];
  private walkers: { active: boolean; profile: string; x: number; z: number; tx: number; tz: number; wait: number }[] = [];
  private patrolT: { active: boolean; giveup: number; x: number; z: number }[] = [
    { active: false, giveup: 0, x: 0, z: 0 }, { active: false, giveup: 0, x: 0, z: 0 },
  ];

  constructor(private canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas);
    this.ui = new GameUI(this.sim, this);
    this.actions = new InputActions(this.engine.input);
  }

  boot() {
    this.menu = new MainMenu({
      onContinue: () => {
        const ok = this.sim.load();
        if (!ok) {
          this.sim.reset();
          this.ui.toast("No readable save — starting fresh.");
        }
        this.restorePos();
        syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
        this.applyAvatar();
        void this.enterPlay(false);
      },
      onNew: () => {
        this.menu.hide();
        this.ui.characterCreation();
      },
      onSettings: () => this.ui.toggle("settings"),
      onCredits: () => this.ui.credits(),
      onQuit: () => window.close(),
    });
    this.city = buildCity(this.engine.world);
    this.spawnPlayer();
    syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
    this.applyAvatar();

    this.sim.onEvent = (text) => {
      this.ui.refreshLog();
      if (this.net.isHost() && /ACT|EMPIRE MODE|Mission complete|joined/i.test(text)) this.net.toastAll(text);
    };
    this.ui.refreshLog();
    this.applySettings(this.ui.settings);
    // cartoon casts (original faces)
    const faces: Record<string, { skin: C3; shirt: C3; trim: C3; pants: C3; hair: C3 | null; eye: "round" | "happy" | "stern"; mouth: "smile" | "smirk" | "flat" | "open"; blush: boolean; beard: boolean }> = {
      bram: { skin: [0.85, 0.62, 0.45], shirt: [0.35, 0.5, 0.3], trim: [0.2, 0.3, 0.18], pants: [0.3, 0.24, 0.18], hair: [0.3, 0.2, 0.12], eye: "round", mouth: "flat", blush: false, beard: true },
      vesper: { skin: [0.95, 0.78, 0.65], shirt: [0.55, 0.35, 0.8], trim: [0.3, 0.2, 0.45], pants: [0.18, 0.16, 0.2], hair: [0.08, 0.08, 0.1], eye: "happy", mouth: "smirk", blush: false, beard: false },
      odell: { skin: [0.55, 0.38, 0.27], shirt: [0.25, 0.55, 0.55], trim: [0.15, 0.32, 0.32], pants: [0.25, 0.22, 0.2], hair: [0.08, 0.08, 0.1], eye: "round", mouth: "smile", blush: false, beard: true },
      junie: { skin: [0.96, 0.8, 0.66], shirt: [0.9, 0.5, 0.15], trim: [0.5, 0.28, 0.08], pants: [0.16, 0.18, 0.22], hair: [0.1, 0.1, 0.12], eye: "happy", mouth: "smile", blush: true, beard: false },
      ines: { skin: [0.93, 0.75, 0.62], shirt: [0.25, 0.4, 0.7], trim: [0.15, 0.22, 0.4], pants: [0.3, 0.28, 0.3], hair: [0.85, 0.7, 0.4], eye: "round", mouth: "flat", blush: true, beard: false },
      corvin: { skin: [0.88, 0.66, 0.5], shirt: [0.12, 0.16, 0.3], trim: [0.08, 0.1, 0.2], pants: [0.14, 0.14, 0.16], hair: [0.6, 0.6, 0.62], eye: "stern", mouth: "flat", blush: false, beard: false },
    };
    for (const [id, spot] of Object.entries(NPC_SPOTS)) {
      const f = faces[id] ?? faces.bram;
      const rig = buildActor(this.engine.world, (texId, img) => this.addTex(texId, img), {
        skin: f.skin, shirt: f.shirt, trim: f.trim, pants: f.pants, hair: f.hair,
        face: { eye: f.eye, mouth: f.mouth, blush: f.blush, beard: f.beard }, tag: `npc-${id}`,
      });
      const ry = Math.atan2(0 - spot[0], 6 - spot[1]);
      poseActor(this.engine.world, rig, spot[0], 0, spot[1], ry, Math.random() * 6, false);
      this.npcRigs.push({ id, rig, x: spot[0], z: spot[1], ry });
    }
    const wshirts: C3[] = [[0.9, 0.6, 0.5], [0.5, 0.8, 0.7], [0.8, 0.7, 0.4], [0.6, 0.5, 0.9], [0.85, 0.45, 0.6], [0.45, 0.7, 0.5]];
    const wskins: C3[] = [[0.95, 0.76, 0.6], [0.72, 0.52, 0.38], [0.55, 0.38, 0.27], [0.93, 0.75, 0.62], [0.85, 0.62, 0.45], [0.96, 0.8, 0.66]];
    for (let i = 0; i < 6; i++) {
      const rig = buildActor(this.engine.world, (texId, img) => this.addTex(texId, img), {
        skin: wskins[i], shirt: wshirts[i], trim: [0.2, 0.2, 0.22], pants: [0.18, 0.18, 0.2],
        hair: [0.15 + i * 0.08, 0.1, 0.08], face: this.faceFor("walker" + i), tag: `walker${i}`,
      });
      poseActor(this.engine.world, rig, 0, -10, 0, 0, 0, false);
      this.walkerRigs.push(rig);
      this.walkerPhase.push(Math.random() * 6);
      this.walkers.push({ active: false, profile: "mabel", x: 0, z: 0, tx: 0, tz: 0, wait: 0 });
    }
    for (let i = 0; i < 2; i++) {
      const rig = buildActor(this.engine.world, (texId, img) => this.addTex(texId, img), {
        skin: i === 0 ? [0.9, 0.7, 0.55] : [0.6, 0.42, 0.3],
        shirt: [0.15, 0.25, 0.7], trim: [0.1, 0.15, 0.4], pants: [0.1, 0.12, 0.2],
        hair: [0.1, 0.14, 0.35], face: { eye: "stern", mouth: "flat", blush: false, beard: false }, tag: `warden${i}`,
      });
      poseActor(this.engine.world, rig, 0, -10, 0, 0, 0, false);
      this.patrolRigs.push(rig);
      this.patrolBlobs.push(makeBlob(this.engine.world, 1.3));
      hideBlob(this.engine.world, this.patrolBlobs[i]);
    }
    // contact shadows + stars + surfaces
    this.blobHero = makeBlob(this.engine.world, 1.4);
    this.blobTruck = makeBlob(this.engine.world, 3.0);
    for (const n of this.npcRigs) {
      stickBlob(this.engine.world, makeBlob(this.engine.world, 1.2), n.x, 0, n.z);
    }
    for (let i = 0; i < 6; i++) {
      const b = makeBlob(this.engine.world, 1.1);
      hideBlob(this.engine.world, b);
      this.walkerBlobs.push(b);
    }
    {
      let s = 1234567;
      const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
      for (let i = 0; i < 50; i++) {
        const e = this.engine.world.create();
        this.engine.world.add(e, "transform", makeTransform((rnd() - 0.5) * 240, 55 + rnd() * 40, (rnd() - 0.5) * 240));
        const t = this.engine.world.get<Transform>(e, "transform")!;
        t.scale.set(0.001, 0.001, 0.001);
        const b = 0.7 + rnd() * 0.3;
        this.engine.world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [b, b, b + 0.05] });
        this.stars.push(e);
      }
    }
    // surfaces + signage (city references these ids)
    this.addTex("grass", paintGrass());
    this.addTex("asphalt", paintAsphalt());
    this.addTex("brick", paintBrick([0.55, 0.32, 0.24]));
    this.addTex("roof", paintRoof([0.3, 0.24, 0.2]));
    this.addTex("water", paintWater());
    this.addTex("sign-mart", paintSign("MART", [0.5, 0.1, 0.1], [1.0, 0.8, 0.2]));
    this.addTex("sign-goods", paintSign("GOODS", [0.1, 0.25, 0.4], [0.9, 0.95, 1.0]));
    this.addTex("sign-dockside", paintSign("DOCKSIDE", [0.12, 0.2, 0.3], [1.0, 0.75, 0.25]));
    this.addTex("sign-office", paintSign("FIELD OFFICE", [0.2, 0.2, 0.22], [0.9, 0.9, 0.9]));
    this.addTex("sign-factory", paintSign("FOUNDRY", [0.3, 0.12, 0.1], [1.0, 0.6, 0.2]));
    this.addTex("sign-repairs", paintSign("REPAIRS", [0.12, 0.2, 0.3], [0.9, 0.95, 1.0]));
    // street lighting rig: warm plaza + two lamps (intensity animated day/night)
    this.engine.renderer.registerMesh("hidden", {
      positions: new Float32Array(0), normals: new Float32Array(0),
      uvs: new Float32Array(0), indices: new Uint16Array(0),
    });
    this.engine.renderer.pointLights = [
      { position: new Vec3(0, 6, 6), color: [1.0, 0.8, 0.55], intensity: 0.6, range: 24 },
      { position: new Vec3(-8, 3.5, 4), color: [1.0, 0.85, 0.6], intensity: 0, range: 20 },
      { position: new Vec3(8, 3.5, 4), color: [1.0, 0.85, 0.6], intensity: 0, range: 20 },
    ];
    this.wireNet();

    // audio needs a user gesture: unlock on first input
    const unlock = () => this.engine.audio.resume();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (this.menuMode) return;
      if (e.code === "KeyE" && !e.repeat) this.interact();
      if (e.code === "KeyF" && !e.repeat) this.toggleFp();
      const digit = /^Digit([1-8])$/.exec(e.code);
      if (digit && !e.repeat) {
        this.ui.selectedBatch = Number(digit[1]) - 1;
        this.ui.renderHotbar();
      }
    });

    this.engine.addSystem((dt) => this.update(dt));
    this.engine.start();
    this.showMenu();
  }

  private showMenu() {
    this.menuMode = true;
    this.ui.closePanel();
    let hasSave = false;
    try { hasSave = localStorage.getItem("undercity-save-v1") !== null; } catch { /* no storage */ }
    this.menu.show(hasSave, "v0.6.0", "Solo or player-hosted co-op up to 4 — host in the Lobby panel after entering.");
  }

  private async enterPlay(fresh: boolean) {
    this.loader.show("UNDERCITY");
    this.loader.stage(0.15, "Waking the city…");
    await nextFrame();
    syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
    this.applyAvatar();
    this.loader.stage(0.45, "Raising towers…");
    await nextFrame();
    this.loader.stage(0.7, "Stocking backrooms…");
    await nextFrame();
    this.loader.stage(0.9, "Waking buyers…");
    await nextFrame();
    await this.loader.hide();
    this.menu.hide();
    this.menuMode = false;
    const cam = this.engine.renderer.camera;
    cam.dist = 10;
    cam.yaw = Math.PI / 4;
    this.ui.toast(fresh
      ? `Welcome, ${this.sim.s.character.name}. Talk to Bram in Rust Flats (gold beacons mark work sites).`
      : `Welcome back, ${this.sim.s.character.name}.`);
    this.ui.refresh();
  }

  quitToMenu(): void {
    this.net.leave();
    this.destroyRemotes();
    this.channel = null;
    this.ui.channel(null, 0);
    this.ui.showPrompt(null);
    this.savePos();
    if (!this.net.isGuest()) this.sim.save();
    const cam = this.engine.renderer.camera;
    cam.dist = 20;
    this.showMenu();
  }

  // ---------- UIActions ----------
  private routed(fn: () => OpResult, action: string, args: Record<string, unknown> = {}): OpResult {
    if (this.net.isGuest()) {
      this.net.request(action, args);
      return { ok: true, msg: "Sent to host…" };
    }
    return fn();
  }

  deposit(n: number): OpResult { return this.routed(() => this.sim.deposit(n), "deposit", { n }); }
  withdraw(n: number): OpResult { return this.routed(() => this.sim.withdraw(n), "withdraw", { n }); }
  buyProperty(id: string, c: boolean): OpResult {
    return this.routed(() => {
      const r = this.sim.buyProperty(id, c);
      if (r.ok) syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
      return r;
    }, "buyProperty", { id, c });
  }
  upgradeProperty(id: string, c: boolean): OpResult {
    return this.routed(() => {
      const r = this.sim.upgradeProperty(id, c);
      if (r.ok) syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
      return r;
    }, "upgradeProperty", { id, c });
  }
  buyVehicle(id: string, owner: "empire" | "player", c: boolean): OpResult {
    return this.routed(() => this.sim.buyVehicle(id, owner, c), "buyVehicle", { id, owner, c });
  }
  buyMaterials(n: number): OpResult { return this.routed(() => this.sim.buyMaterials(n), "buyMaterials", { n }); }
  mixBatch(idx: number, add: string, name: string): OpResult {
    return this.routed(() => this.sim.mixBatch(idx, add, name), "mixBatch", { idx, add, name });
  }
  stashCash(prop: string, n: number): OpResult {
    return this.routed(() => this.sim.stashCash(prop, n), "stashCash", { prop, n });
  }
  unstashCash(prop: string, n: number): OpResult {
    return this.routed(() => this.sim.unstashCash(prop, n), "unstashCash", { prop, n });
  }
  produce(p: string, q: Quality): OpResult { return this.routed(() => this.sim.produce(p, q), "produce", { p, q }); }
  sell(c: string, b: number, price: number): OpResult {
    return this.routed(() => this.sim.sellTo(c, b, price), "sell", { c, b, price });
  }
  talk(n: string, ch: number): OpResult { return this.routed(() => this.sim.talk(n, ch), "talk", { n, ch }); }
  recruit(n: string): OpResult { return this.routed(() => this.sim.recruit(n), "recruit", { n }); }
  assign(n: string, p: string | null): OpResult {
    return this.routed(() => this.sim.assignEmployee(n, p), "assign", { n, p });
  }
  payTribute(n: number): OpResult { return this.routed(() => this.sim.payTribute(n), "payTribute", { n }); }
  startJob(id: string): void { this.activeJob = id; }

  async lobby(op: string, payload: string): Promise<string> {
    if (op === "host") {
      this.net.mode = "host";
      this.net.selfName = payload.trim().slice(0, 16) || this.sim.s.character.name;
      this.net.pushRoster();
      return `Hosting as ${this.net.selfName}.`;
    }
    if (op === "invite") return this.net.createInvite();
    if (op === "accept") {
      await this.net.acceptGuest(payload);
      return "Guest accepted.";
    }
    if (op === "join") {
      const { code, name } = JSON.parse(payload) as { code: string; name: string };
      const answer = await this.net.join(code, name || this.sim.s.character.name);
      this.ui.toast("Answer created — send it back to the host.");
      return answer;
    }
    if (op === "leave") {
      this.destroyRemotes();
      this.net.leave();
      return "Offline.";
    }
    throw new Error("Unknown lobby op.");
  }
  setCharacter(name: string, body: [number, number, number], accent: [number, number, number], hat: boolean): void {
    this.sim.s.character = { name, body, accent, hat };
    this.sim.s.customized = true;
    this.sim.log(`${name} takes charge of the crew.`);
    this.net.selfName = name;
    this.applyAvatar();
    this.sim.save();
    if (this.menuMode) void this.enterPlay(true);
  }
  save(): void {
    if (this.net.isGuest()) { this.ui.toast("Only the host's machine saves."); return; }
    this.savePos();
    this.sim.save();
  }
  newGame(): void {
    try { localStorage.removeItem("undercity-save-v1"); localStorage.removeItem(SAVE_POS_KEY); } catch { /* fresh start anyway */ }
    location.reload();
  }
  applySettings(s: Settings): void {
    const far = s.preset === "Low" ? 40 : s.preset === "Medium" ? 70 : s.preset === "High" ? 100 : 140;
    this.engine.renderer.camera.far = far;
    if (s.preset === "Low") this.engine.renderer.pointLights.length = 0;
    else if (this.engine.renderer.pointLights.length === 0) {
      this.engine.renderer.pointLights = [
        { position: new Vec3(0, 6, 6), color: [1.0, 0.8, 0.55], intensity: 0.6, range: 24 },
        { position: new Vec3(-8, 3.5, 4), color: [1.0, 0.85, 0.6], intensity: 0, range: 20 },
        { position: new Vec3(8, 3.5, 4), color: [1.0, 0.85, 0.6], intensity: 0, range: 20 },
      ];
    }
    if (s.fullscreen && document.fullscreenElement == null) void document.documentElement.requestFullscreen().catch(() => undefined);
    if (!s.fullscreen && document.fullscreenElement != null) void document.exitFullscreen().catch(() => undefined);
    this.engine.audio.setVolume(s.volume);
    if (s.music) this.engine.audio.startMusic();
    else this.engine.audio.stopMusic();
  }

  private toggleFp() {
    this.fp = !this.fp;
    if (this.rig) {
      if (this.fp) setRigMesh(this.engine.world, this.rig, "hidden", this.rigHidden);
      else restoreRigMesh(this.engine.world, this.rigHidden);
    }
    if (this.hat !== null) {
      const ht = this.engine.world.get<Transform>(this.hat, "transform")!;
      if (this.fp) ht.scale.set(0.001, 0.001, 0.001);
      else ht.scale.set(1.0, 0.25, 1.0);
    }
    this.ui.toast(this.fp ? "First-person view (F to switch back)." : "Third-person view.");
  }

  // ---------- setup ----------
  private spawnPlayer() {
    const world = this.engine.world;
    const e = world.create();
    const t = makeTransform(0, 2, 6);
    t.scale.set(0.9, 1.5, 0.9);
    world.add(e, "transform", t);
    world.add<MeshRef>(e, "mesh", { meshId: "hidden", color: [1, 1, 1] });
    world.add(e, "collider", { halfExtents: new Vec3(0.5, 0.5, 0.5), isStatic: false });
    world.add(e, "rigidbody", makeRigidbody(true, 1));
    this.player = e;
  }

  private addTex(id: string, img: TexImageSource) {
    this.engine.renderer.registerCanvas(id, img);
  }

  private destroyRig(rig: ActorRig) {
    const parts: (Entity | null | undefined)[] = [rig.head, rig.hair, rig.torso, rig.armL, rig.armR, rig.legL, rig.legR, (rig as { hairBack?: Entity }).hairBack];
    for (const e of parts) if (e != null) this.engine.world.destroy(e);
  }

  // Deterministic cartoon face from a name (no save-format change).
  private faceFor(name: string): { eye: "round" | "happy" | "stern"; mouth: "smile" | "smirk" | "flat" | "open"; blush: boolean; beard: boolean } {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const eyes = ["round", "happy", "stern", "round"] as const;
    const mouths = ["smile", "smirk", "flat", "smile", "open"] as const;
    return {
      eye: eyes[h % eyes.length],
      mouth: mouths[(h >> 2) % mouths.length],
      blush: (h & 1) === 0,
      beard: ((h >> 4) % 4) === 0,
    };
  }

  private applyAvatar() {
    const world = this.engine.world;
    if (this.rig) { this.destroyRig(this.rig); this.rig = null; }
    this.rigHidden.clear();
    const ch = this.sim.s.character;
    this.rig = buildActor(world, (id, img) => this.addTex(id, img), {
      skin: [0.95, 0.76, 0.6],
      shirt: [...ch.body] as C3,
      trim: [...ch.accent] as C3,
      pants: [0.16, 0.18, 0.24],
      hair: [0.25, 0.16, 0.1],
      face: this.faceFor(ch.name),
      tag: "player",
    });
    if (this.fp && this.rig) setRigMesh(world, this.rig, "hidden", this.rigHidden);
    if (this.hat !== null) { world.destroy(this.hat); this.hat = null; }
    if (ch.hat) {
      const h = world.create();
      world.add(h, "transform", makeTransform(0, 0, 0));
      world.add<MeshRef>(h, "mesh", { meshId: this.fp ? "hidden" : "cube", color: [...ch.accent] as [number, number, number] });
      const ht = world.get<Transform>(h, "transform")!;
      ht.scale.set(1.0, 0.25, 1.0);
      this.hat = h;
    }
    const t = world.get<Transform>(this.player, "transform");
    if (t && this.rig) poseActor(world, this.rig, t.position.x, Math.max(0, t.position.y - 0.75), t.position.z, t.rotationY, 0, false);
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
    const bt = this.engine.world.get<Transform>(this.city.bench, "transform")!;
    this.nearbyBench = Math.hypot(p.x - bt.position.x, p.z - bt.position.z) < 3.2;
    this.nearbyWalker = -1;
    let wb = 3.0;
    this.walkers.forEach((w, i) => {
      if (!w.active) return;
      const d = Math.hypot(p.x - w.x, p.z - w.z);
      if (d < wb) { wb = d; this.nearbyWalker = i; }
    });

    if (this.driving) this.ui.showPrompt(`<kbd>E</kbd> Exit truck`);
    else if (this.nearbyNPC) this.ui.showPrompt(`<kbd>E</kbd> Talk to ${this.nearbyNPC}`);
    else if (this.nearbyWalker >= 0) {
      const prof = CUSTOMERS.find((c) => c.id === this.walkers[this.nearbyWalker].profile)!;
      this.ui.showPrompt(`<kbd>E</kbd> Deal — buyer wants <b>${prof.preferredQuality}</b> (carrying ${this.sim.s.stock.length} batches)`);
    } else if (this.nearbyBeacon && this.carrying) this.ui.showPrompt(`<kbd>E</kbd> Deliver crate (+$120)`);
    else if (this.nearbyBeacon && this.activeJob) this.ui.showPrompt(`<kbd>E</kbd> Work: ${CONTRACTS.find((c) => c.id === this.activeJob)?.name}`);
    else if (this.nearbyBeacon) this.ui.showPrompt(`Pick a <b>Job</b> first (J), then work here`);
    else if (this.nearbyBench) this.ui.showPrompt(`Mixing bench — open <b>Biz (U)</b> to blend batches`);
    else if (this.nearbyTruck) this.ui.showPrompt(`<kbd>E</kbd> Drive work truck`);
    else if (this.nearbyCrates && !this.carrying) this.ui.showPrompt(`<kbd>E</kbd> Load crate (needs warehouse)`);
    else this.ui.showPrompt(null);
  }

  private interact() {
    if (this.driving) { this.exitTruck(); return; }
    if (this.nearbyNPC) { this.ui.talkDialog(this.nearbyNPC); return; }
    if (this.nearbyWalker >= 0) {
      const w = this.walkers[this.nearbyWalker];
      this.ui.dealDialog(w.profile, this.nearbyWalker);
      return;
    }
    if (this.nearbyBeacon && this.carrying) { this.deliver(); return; }
    if (this.nearbyBeacon && this.activeJob) { this.startWork(); return; }
    if (this.nearbyTruck) { this.enterTruck(); return; }
    if (this.nearbyCrates && !this.carrying) { this.pickupCrate(); return; }
  }

  dealTo(walkerIdx: number, customerId: string, batch: number, price: number) {
    if (this.net.isGuest()) {
      this.net.request("deal", { profile: customerId, batch, price, seen: false });
      this.deactivateWalker(walkerIdx);
      this.ui.toast("Offer sent to host…");
      return;
    }
    const r = this.sim.sellTo(customerId, batch, price);
    // seen by patrols? +heat
    const seen = this.patrolT.some((pt) => {
      if (!pt.active) return false;
      const p = this.playerPos();
      return Math.hypot(p.x - pt.x, p.z - pt.z) < 20;
    });
    if (r.ok && seen) {
      this.sim.addHeat(6, "deal spotted by Wardens");
      this.ui.toast("A Warden saw that deal. Move!");
    } else {
      this.ui.toast(r.msg);
    }
    if (r.ok) this.deactivateWalker(walkerIdx);
    this.ui.refresh();
  }

  private deactivateWalker(i: number) {
    this.walkers[i].active = false;
    poseActor(this.engine.world, this.walkerRigs[i], 0, -10, 0, 0, 0, false);
    hideBlob(this.engine.world, this.walkerBlobs[i]);
  }

  private startWork() {
    const def = CONTRACTS.find((c) => c.id === this.activeJob);
    if (!def) return;
    const p = this.playerPos();
    this.channel = {
      label: `Working: ${def.name}… stay at the beacon`,
      t: 0, dur: def.workTime, ax: p.x, az: p.z, radius: 3.5,
      onDone: () => this.finishWork(def.id),
    };
  }

  private finishWork(contractId: string) {
    if (this.net.isGuest()) {
      this.net.request("work", { contract: contractId });
      this.activeJob = null;
      this.ui.toast("Work sent to host…");
      return;
    }
    const r = this.sim.completeContract(contractId);
    this.engine.audio.pickup();
    this.ui.toast(r.msg);
    if (this.sim.s.act === 5 && (contractId === "commercial" || contractId === "development")) {
      this.sim.bumpMission("defend", undefined, 1);
    }
    this.activeJob = null;
    this.ui.refresh();
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
    if (this.net.isGuest()) {
      this.net.request("deliver", {});
      this.ui.toast("Delivery sent to host…");
      return;
    }
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

  // ---------- street systems: walkers, patrols, day/night ----------
  private streetUpdate(dt: number) {
    if (this.immunityT > 0) this.immunityT -= dt;
    const night = isNightHour(this.sim.hour());
    const p = this.playerPos();

    // walkers: wander the streets at night
    this.walkers.forEach((w, i) => {
      const rig = this.walkerRigs[i];
      if (!w.active) return;
      if (!night) { this.deactivateWalker(i); return; }
      w.wait -= dt;
      const dx = w.tx - w.x, dz = w.tz - w.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6 || w.wait <= 0) {
        w.tx = Math.max(-55, Math.min(55, w.x + (Math.random() - 0.5) * 24));
        w.tz = Math.max(-55, Math.min(55, w.z + (Math.random() - 0.5) * 24));
        w.wait = 6 + Math.random() * 6;
      } else {
        const sp = 1.6 * dt;
        w.x += (dx / d) * sp;
        w.z += (dz / d) * sp;
        this.walkerPhase[i] += dt * 7;
      }
      poseActor(this.engine.world, rig, w.x, 0, w.z, Math.atan2(dx, dz), this.walkerPhase[i], d >= 0.6);
      stickBlob(this.engine.world, this.walkerBlobs[i], w.x, 0, w.z);
    });

    // patrols: Wardens hunt when heat is high
    const heat = this.sim.s.heat;
    let anyActive = false;
    this.patrolT.forEach((pt, i) => {
      const rig = this.patrolRigs[i];
      if (!pt.active) {
        if (heat >= PATROL_MIN_HEAT && this.immunityT <= 0) {
          pt.active = true;
          pt.giveup = PATROL_GIVEUP;
          const a = Math.random() * Math.PI * 2;
          pt.x = Math.max(-55, Math.min(55, p.x + Math.cos(a) * 16));
          pt.z = Math.max(-55, Math.min(55, p.z + Math.sin(a) * 16));
          this.patrolPhase[i] = 0;
          poseActor(this.engine.world, rig, pt.x, 0, pt.z, 0, 0, false);
          if (!this.warnedPatrol) {
            this.warnedPatrol = true;
            this.ui.toast("Wardens on the block — break line of sight or cool your Heat!");
            this.engine.audio.blip(140, 0.4, "sawtooth", 0.08);
          }
        }
        return;
      }
      anyActive = true;
      if (heat < 40) { this.deactivatePatrol(i); return; }
      pt.giveup -= dt;
      if (pt.giveup <= 0) {
        this.deactivatePatrol(i);
        this.ui.toast("You lost the Wardens.");
        return;
      }
      const dx = p.x - pt.x, dz = p.z - pt.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.6) { this.busted(i); return; }
      if (d > 0.01) {
        const sp = PATROL_SPEED * dt;
        pt.x += (dx / d) * sp;
        pt.z += (dz / d) * sp;
        this.patrolPhase[i] += dt * 8;
      }
      poseActor(this.engine.world, rig, pt.x, 0, pt.z, Math.atan2(dx, dz), this.patrolPhase[i], true);
      stickBlob(this.engine.world, this.patrolBlobs[i], pt.x, 0, pt.z);
    });
    if (!anyActive) this.warnedPatrol = false;
  }

  private deactivatePatrol(i: number) {
    this.patrolT[i].active = false;
    poseActor(this.engine.world, this.patrolRigs[i], 0, -10, 0, 0, 0, false);
    hideBlob(this.engine.world, this.patrolBlobs[i]);
  }

  private busted(by: number) {
    void by;
    if (this.driving) this.exitTruck();
    if (this.carrying) {
      this.carrying = false;
      if (this.carryCrate !== null) { this.engine.world.destroy(this.carryCrate); this.carryCrate = null; }
    }
    if (this.net.isGuest()) {
      this.net.request("busted", {});
      this.patrolT.forEach((_, i) => this.deactivatePatrol(i));
      this.immunityT = BUST_IMMUNITY;
      this.ui.toast("Busted — host is seizing the goods…");
      return;
    }
    const { stockLost, cashLost } = this.sim.busted();
    this.patrolT.forEach((_, i) => this.deactivatePatrol(i));
    this.immunityT = BUST_IMMUNITY;
    this.shakeT = 0.6;
    this.engine.audio.blip(110, 0.6, "sawtooth", 0.1);
    this.ui.bustedModal(stockLost, cashLost);
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

  // ---------- net ----------
  private wireNet() {
    const net = this.net;
    net.onSnap = (s) => {
      this.sim.s = s as SimState;
      syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
      this.ui.refresh();
    };
    net.onPos = (p) => this.ensureRemote(p);
    net.onRoster = (list) => {
      for (const r of list) {
        if (r.id === net.selfId) continue;
        this.ensureRemote({ ...r, x: 0, y: 2, z: 6, ry: 0 });
      }
    };
    net.onPeerLeft = (id) => {
      const r = this.remotes.get(id);
      if (r !== undefined) {
        this.destroyRig(r.rig);
        this.engine.world.destroy(r.blob);
        this.remotes.delete(id);
      }
    };
    net.onRes = (_reqId, _ok, msg) => this.ui.toast(msg);
    net.onToast = (text) => this.ui.toast(text);
    net.onReq = (from, action, args, reqId) => {
      const num = (v: unknown) => Number(v);
      const str = (v: unknown) => String(v ?? "");
      let r: OpResult = { ok: false, msg: "Unknown action." };
      const before = this.sim.s.doneMissions.length;
      switch (action) {
        case "deposit": r = this.sim.deposit(num(args.n)); break;
        case "withdraw": r = this.sim.withdraw(num(args.n)); break;
        case "buyProperty":
          r = this.sim.buyProperty(str(args.id), args.c === true);
          if (r.ok) syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
          break;
        case "upgradeProperty":
          r = this.sim.upgradeProperty(str(args.id), args.c === true);
          if (r.ok) syncPropertyVisuals(this.engine.world, this.city, this.sim.s.props);
          break;
        case "buyVehicle": r = this.sim.buyVehicle(str(args.id), args.owner === "player" ? "player" : "empire", args.c === true); break;
        case "buyMaterials": r = this.sim.buyMaterials(num(args.n)); break;
        case "produce": r = this.sim.produce(str(args.p), (args.q as "POOR" | "NORMAL" | "PREMIUM") ?? "NORMAL"); break;
        case "mixBatch": r = this.sim.mixBatch(num(args.idx), str(args.add), str(args.name)); break;
        case "sell": r = this.sim.sellTo(str(args.c), num(args.b), num(args.price)); break;
        case "deal":
          r = this.sim.sellTo(str(args.profile), num(args.batch), num(args.price));
          if (r.ok && args.seen === true) this.sim.addHeat(6, "deal spotted by Wardens");
          break;
        case "talk": r = this.sim.talk(str(args.n), num(args.ch)); break;
        case "recruit": r = this.sim.recruit(str(args.n)); break;
        case "assign": r = this.sim.assignEmployee(str(args.n), args.p == null ? null : str(args.p)); break;
        case "payTribute": r = this.sim.payTribute(num(args.n)); break;
        case "stashCash": r = this.sim.stashCash(str(args.prop), num(args.n)); break;
        case "unstashCash": r = this.sim.unstashCash(str(args.prop), num(args.n)); break;
        case "work":
          r = this.sim.completeContract(str(args.contract));
          if (this.sim.s.act === 5 && (str(args.contract) === "commercial" || str(args.contract) === "development")) {
            this.sim.bumpMission("defend", undefined, 1);
          }
          break;
        case "deliver":
          this.sim.earn(120, "crate delivery (crew)");
          this.sim.gainXp("logistics", 14);
          r = { ok: true, msg: "Delivered +$120." };
          break;
        case "busted": {
          const lost = this.sim.busted();
          r = { ok: true, msg: `Busted: lost ${lost.stockLost}u stock + $${lost.cashLost}.` };
          break;
        }
        default: break;
      }
      if (this.sim.s.doneMissions.length > before) {
        this.net.toastAll(this.sim.s.log[0] ?? "Mission complete.");
      }
      net.respond(from, reqId, r.ok, r.msg);
      this.ui.refresh();
    };
  }

  private ensureRemote(p: RemotePlayer) {
    let r = this.remotes.get(p.id);
    if (r === undefined) {
      const rig = buildActor(this.engine.world, (id, img) => this.addTex(id, img), {
        skin: [0.9, 0.72, 0.55], shirt: [...p.color] as C3, trim: [0.2, 0.2, 0.22],
        pants: [0.16, 0.18, 0.22], hair: [0.2, 0.14, 0.1],
        face: this.faceFor(p.name), tag: `remote-${p.id}`,
      });
      r = { rig, phase: 0, x: p.x, z: p.z, blob: makeBlob(this.engine.world, 1.3) };
      this.remotes.set(p.id, r);
    }
    const moved = Math.hypot(p.x - r.x, p.z - r.z) > 0.05;
    if (moved) r.phase += 0.15;
    r.x = p.x; r.z = p.z;
    // recolor shirt to peer color
    for (const part of [r.rig.torso, r.rig.armL, r.rig.armR]) {
      const mm = this.engine.world.get<MeshRef>(part, "mesh");
      if (mm) mm.color = [...p.color] as C3;
    }
    poseActor(this.engine.world, r.rig, p.x, Math.max(0, p.y - 0.75), p.z, p.ry, r.phase, moved);
    stickBlob(this.engine.world, r.blob, p.x, 0, p.z);
  }

  private destroyRemotes() {
    for (const [, r] of this.remotes) {
      this.destroyRig(r.rig);
      this.engine.world.destroy(r.blob);
    }
    this.remotes.clear();
  }

  private update(dt: number) {
    const world = this.engine.world;
    if (this.menuMode) {
      const cam = this.engine.renderer.camera;
      cam.yaw += dt * 0.06;
      cam.dist = 20;
      cam.target.set(0, 3, 0);
      return;
    }
    if (!this.net.isGuest()) this.sim.tick(dt);

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
    const hasBoard = this.sim.s.vehicles.some((v) => v.id === "board");
    const footMult = hasBoard ? 1.35 : 1.0;
    const driveMult = Math.min(1.5, 1 + this.sim.s.vehicles.length * 0.1);

    if (this.driving) {
      const tt = world.get<Transform>(this.city.truck, "transform")!;
      const trb = world.get<Rigidbody>(this.city.truck, "rigidbody")!;
      this.driver.move(tt, trb, wishX * driveMult, wishZ * driveMult, false, dt);
      tt.rotationY = yaw + Math.PI;
      const pt = world.get<Transform>(this.player, "transform")!;
      const prb = world.get<Rigidbody>(this.player, "rigidbody")!;
      pt.position.set(tt.position.x, tt.position.y + 1.2, tt.position.z);
      prb.velocity.set(0, 0, 0);
      if (this.rig) {
        poseActor(world, this.rig, pt.position.x, Math.max(0, pt.position.y - 0.75), pt.position.z, tt.rotationY, this.walkPhase, false);
        stickBlob(world, this.blobHero, pt.position.x, 0, pt.position.z);
      }
      stickBlob(world, this.blobTruck, tt.position.x, 0, tt.position.z);
    } else {
      const t = world.get<Transform>(this.player, "transform")!;
      const rb = world.get<Rigidbody>(this.player, "rigidbody")!;
      const wasAir = !rb.grounded;
      this.walker.move(t, rb, wishX * footMult, wishZ * footMult, jump, dt, () => this.engine.audio.jump());
      if (wasAir && rb.grounded) { this.engine.audio.land(); this.shakeT = Math.max(this.shakeT, 0.12); }
      if (this.actions.reset()) {
        t.position.set(0, 2, 6);
        rb.velocity.set(0, 0, 0);
      }
      // face movement + walk-cycle the cartoon rig
      const pMoving = Math.abs(wishX) + Math.abs(wishZ) > 0.1;
      if (pMoving) {
        t.rotationY = Math.atan2(wishX, wishZ);
        this.walkPhase += dt * 9;
      }
      if (this.rig) {
        poseActor(world, this.rig, t.position.x, Math.max(0, t.position.y - 0.75), t.position.z, t.rotationY, this.walkPhase, pMoving);
        stickBlob(world, this.blobHero, t.position.x, 0, t.position.z);
      }
      // hat + crate follow
      if (this.hat !== null) {
        const ht = world.get<Transform>(this.hat, "transform")!;
        ht.position.set(t.position.x, t.position.y + 1.15, t.position.z);
        ht.rotationY = t.rotationY;
      }
      if (this.carryCrate !== null) {
        const ct = world.get<Transform>(this.carryCrate, "transform")!;
        ct.position.set(t.position.x, t.position.y + 0.4, t.position.z + 0.8);
      }
      // NPC idle life (breathing bob)
      const nowS = performance.now() / 1000;
      for (const n of this.npcRigs) {
        poseActor(world, n.rig, n.x, 0, n.z, n.ry + Math.sin(nowS * 0.3 + n.x) * 0.15, nowS + n.x, false);
      }
    }

    const drag = this.engine.input.consumeDrag();
    this.engine.renderer.camera.updateOrbit(drag.dx, drag.dy);

    // camera: first-person head-cam or third-person follow
    {
      const cam = this.engine.renderer.camera;
      const focus = this.driving
        ? world.get<Transform>(this.city.truck, "transform")!.position
        : this.playerPos();
      if (this.fp) {
        const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
        const fx = -Math.cos(cam.yaw) * cp, fy = -sp, fz = -Math.sin(cam.yaw) * cp;
        const hy = focus.y + (this.driving ? 1.4 : 1.0);
        cam.position.set(focus.x, hy, focus.z);
        cam.target.set(focus.x + fx * 6, hy + fy * 6, focus.z + fz * 6);
      } else {
        cam.follow(focus);
      }
      if (this.shakeT > 0) {
        cam.target.x += (Math.random() - 0.5) * this.shakeT * 1.6;
        cam.target.z += (Math.random() - 0.5) * this.shakeT * 1.6;
        this.shakeT = Math.max(0, this.shakeT - dt * 1.8);
      }
    }

    this.streetUpdate(dt);

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
      // atmosphere follows the clock
      const frame = skyAt(this.sim.hour());
      const r = this.engine.renderer;
      r.clearColor = [...frame.sky];
      r.fogColor = [...frame.fog];
      r.lightIntensity = frame.sunI;
      if (r.pointLights.length >= 3) {
        r.pointLights[1].intensity = frame.lamp * 1.1;
        r.pointLights[2].intensity = frame.lamp * 1.1;
      }
      // stars out at night
      const starOn = frame.lamp > 0.5;
      for (const s of this.stars) {
        const t = world.get<Transform>(s, "transform")!;
        const want = starOn ? 0.5 : 0.001;
        if (Math.abs(t.scale.x - want) > 0.01) t.scale.set(want, want, want);
      }
      // sun / moon disc
      {
        const sun = this.engine.world.get<Transform>(this.city.sun, "transform")!;
        const sunM = this.engine.world.get<MeshRef>(this.city.sun, "mesh")!;
        const a = ((this.sim.hour() - 6) / 12) * Math.PI; // rises 6h, sets 18h
        const dayUp = Math.sin(a) > 0;
        const sa = dayUp ? a : a + Math.PI;
        sun.position.set(Math.cos(sa) * 120, Math.max(6, Math.sin(sa) * 55), -70);
        sunM.color = dayUp ? [...frame.sunColor] : [0.8, 0.85, 0.95];
      }
      // spawn night walkers near the player
      if (frame.lamp > 0.5) {
        const active = this.walkers.filter((w) => w.active).length;
        if (active < 4 && Math.random() < 0.3) {
          const i = this.walkers.findIndex((w) => !w.active);
          if (i >= 0) {
            const roll = Math.random();
            const profile = roll < 0.4 ? "mabel" : roll < 0.75 ? "dario" : "petra";
            const p = this.playerPos();
            const x = Math.max(-55, Math.min(55, p.x + (Math.random() - 0.5) * 24));
            const z = Math.max(-55, Math.min(55, p.z + (Math.random() - 0.5) * 24));
            this.walkers[i] = { active: true, profile, x, z, tx: x, tz: z, wait: 2 };
            poseActor(this.engine.world, this.walkerRigs[i], x, 0, z, 0, 0, false);
          }
        }
      }
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
      this.ui.fps = this.engine.loop.time.fps;
      this.ui.renderHotbar();
      this.ui.renderCompass(this.engine.renderer.camera.yaw);
      // net traffic @ ~4Hz
      if (this.net.isHost()) {
        this.snapTimer += 0.25;
        if (this.snapTimer >= 0.5) {
          this.snapTimer = 0;
          this.net.snap(this.sim.s);
        }
        const me = this.playerPos();
        const mt = this.engine.world.get<Transform>(this.player, "transform")!;
        this.net.posList([
          { id: this.net.selfId, name: this.net.selfName, color: this.net.selfColor, x: me.x, y: me.y, z: me.z, ry: mt.rotationY },
          ...[...this.net.players.values()],
        ]);
      } else if (this.net.isGuest()) {
        const me = this.playerPos();
        const mt = this.engine.world.get<Transform>(this.player, "transform")!;
        this.net.sendPos(me.x, me.y, me.z, mt.rotationY);
      }
    }

    // autosave (host storage only)
    this.saveTimer += dt;
    if (this.saveTimer > 30) {
      this.saveTimer = 0;
      this.savePos();
      if (!this.net.isGuest()) this.sim.save();
    }
  }
}
