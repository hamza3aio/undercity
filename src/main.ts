import { Engine } from "./core/engine.js";
import { Vec3 } from "./math/vec3.js";
import { CharacterController } from "./physics/character.js";
import { InputActions } from "./input/actions.js";
import { HUD } from "./ui/hud.js";
import { EditorOverlay } from "./editor/overlay.js";
import { makeTrigger } from "./physics/trigger.js";
import {
  makeRigidbody,
  makeTransform,
  type MeshRef,
  type PlayerTag,
  type Rigidbody,
  type Spin,
  type Transform,
} from "./ecs/components.js";
import type { Entity } from "./ecs/world.js";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const stats = document.getElementById("stats")!;
const startBtn = document.getElementById("start")!;

const engine = new Engine(canvas);
const { world, input, audio, physics, renderer } = engine;
const actions = new InputActions(input);
const character = new CharacterController({ speed: 6, jumpSpeed: 8, acceleration: 40 });
const hud = new HUD(stats);
hud.attachMessage(document.getElementById("msg")!);

// Warm point light above the arena (Phase 2 lighting demo)
renderer.pointLights.push({
  position: new Vec3(0, 6, -2),
  color: [1.0, 0.8, 0.5],
  intensity: 0.9,
  range: 20,
});

function spawnBox(
  x: number, y: number, z: number,
  color: [number, number, number],
  opts: { static?: boolean; scale?: Vec3; spin?: number; player?: boolean; textureId?: string } = {}
): Entity {
  const e = world.create();
  const t = makeTransform(x, y, z);
  if (opts.scale) t.scale = opts.scale;
  world.add(e, "transform", t);
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color, textureId: opts.textureId });
  world.add(e, "collider", {
    halfExtents: new Vec3(0.5, 0.5, 0.5),
    isStatic: opts.static ?? false,
  });
  if (opts.static) {
    world.add(e, "rigidbody", { velocity: new Vec3(), useGravity: false, mass: 0, grounded: true });
  } else {
    world.add(e, "rigidbody", makeRigidbody(true, 1));
  }
  if (opts.spin) world.add<Spin>(e, "spin", { speed: opts.spin });
  if (opts.player) world.add<PlayerTag>(e, "player", { speed: 6, jumpSpeed: 8 });
  return e;
}

// Ground (visual plane + static collider)
{
  const g = world.create();
  world.add(g, "transform", makeTransform(0, -0.51, 0));
  world.add<MeshRef>(g, "mesh", { meshId: "ground", color: [0.4, 0.7, 0.45], textureId: "checker", uvScale: 4 });
  world.add(g, "collider", {
    halfExtents: new Vec3(15, 0.5, 15),
    isStatic: true,
  });
}

// Platforms (textured to show Phase 2 materials)
spawnBox(3, 0.5, -2, [0.7, 0.7, 0.75], { static: true, scale: new Vec3(3, 1, 3), textureId: "checker" });
spawnBox(-3, 1.5, 2, [0.75, 0.6, 0.4], { static: true, scale: new Vec3(2, 1, 2), textureId: "checker" });
spawnBox(0, 2.5, -5, [0.5, 0.5, 0.8], { static: true, scale: new Vec3(2, 1, 2), textureId: "checker" });

// Goal trigger above the far platform (Phase 3 demo)
const goal = world.create();
world.add(goal, "transform", makeTransform(0, 3.5, -5));
world.add(goal, "trigger", makeTrigger(1.5, 1.5, 1.5));
engine.triggers.onEnter = (tr, other) => {
  if (tr === goal && other === player) {
    audio.trigger();
    hud.showMessage("Goal reached! Press R to reset.", 3);
  }
};

// Player
const player = spawnBox(0, 2, 3, [0.2, 0.5, 1.0], { player: true });

// Spinning collectibles (no collision response needed — kinematic look)
const coins: Entity[] = [
  spawnBox(3, 2, -2, [1.0, 0.8, 0.2], { spin: 2.5 }),
  spawnBox(-3, 3, 2, [1.0, 0.8, 0.2], { spin: 2.5 }),
  spawnBox(0, 4, -5, [1.0, 0.8, 0.2], { spin: 3.0 }),
];
for (const c of coins) {
  world.remove(c, "collider");
  world.remove(c, "rigidbody");
  const t = world.get<Transform>(c, "transform")!;
  t.scale.set(0.5, 0.5, 0.5);
}

// --- Systems ---
engine.addSystem((dt) => {
  // Player movement, camera-relative (Phase 4 InputActions + Phase 3 CharacterController)
  const t = world.get<Transform>(player, "transform")!;
  const rb = world.get<Rigidbody>(player, "rigidbody")!;
  const tag = world.get<PlayerTag>(player, "player")!;
  void tag;
  const move = actions.move();
  const yaw = renderer.camera.yaw;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const wishX = move.x * cos - move.z * sin;
  const wishZ = -move.z * cos - move.x * sin;
  const wasGrounded = rb.grounded;
  character.move(t, rb, wishX, wishZ, actions.jump(), dt, () => audio.jump());
  void wasGrounded;
  if (actions.reset()) {
    t.position.set(0, 2, 3);
    rb.velocity.set(0, 0, 0);
  }

  // Spin collectibles + pickup check
  for (const c of [...coins]) {
    const ct = world.get<Transform>(c, "transform");
    const cs = world.get<Spin>(c, "spin");
    if (!ct || !cs) continue;
    ct.rotationY += cs.speed * dt;
    ct.position.y += Math.sin(performance.now() / 500 + c) * dt * 0.5;
    const d = ct.position.clone().sub(t.position).length();
    if (d < 1.0) {
      world.destroy(c);
      coins.splice(coins.indexOf(c), 1);
      audio.pickup();
    }
  }

  // Camera
  const drag = input.consumeDrag();
  renderer.camera.updateOrbit(drag.dx, drag.dy);
  renderer.camera.follow(t.position);
});

physics.onCollide = ({ a, b }) => {
  if (a === player && (b === -1 || b === -2)) {
    if (b === -1) audio.land();
  }
};

// HUD
let hudTimer = 0;
let editor: EditorOverlay | null = null;
if (new URLSearchParams(location.search).has("editor")) {
  editor = new EditorOverlay(world, document.getElementById("ui")!);
}
engine.addSystem((dt) => {
  hud.update(dt);
  hudTimer += dt;
  if (hudTimer > 0.25) {
    hudTimer = 0;
    hud.setStats(`${engine.loop.time.fps} fps · ${world.count()} entities · ${coins.length} coins · Glitch v1.0`);
  }
  if (editor && !editor.isPaused()) editor.update();
});

startBtn.addEventListener("click", () => {
  audio.resume();
  startBtn.remove();
  canvas.focus();
});

engine.start();
