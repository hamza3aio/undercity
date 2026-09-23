# UNDERCITY v0.1

3D open-world empire game built with Glitch Game Engine (raw WebGL2, zero runtime deps).

## Modules

- `src/math/` — `Vec3`, `Mat4`
- `src/core/` — `GameLoop` (fixed-step), `Time`, `Engine` (physics + triggers wired)
- `src/ecs/` — `World`, `Transform/Rigidbody/BoxCollider/MeshRef(+texture)/Spin/PlayerTag`
- `src/rendering/` — `Renderer` (textured, multi-light), `Camera`, `GpuMesh` (+UVs), `texture.ts`, `material.ts`, `lights.ts`, `obj.ts`
- `src/physics/` — AABB `physics.ts`, `raycast.ts`, `trigger.ts`, `character.ts`
- `src/input/` — `input.ts` + `actions.ts` (move/jump/reset)
- `src/audio/` — `AudioEngine` (blips, positional, music loop)
- `src/scene/` — `prefab.ts` (box/platform/pickup/trigger), `scene.ts` (save/load JSON)
- `src/assets/` — `loader.ts` (texture/OBJ/JSON with cache)
- `src/editor/` — `overlay.ts` (hierarchy + inspector + save/load, `?editor=1`)
- `src/examples/` — `second-level.ts`
- `src/ui/` — `hud.ts`

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173. Click Start: `WASD` move, `Space` jump, drag orbit, `R` reset. Add `?editor=1` for the editor overlay. Reach the far platform to trigger the goal message.

## Authoring

```ts
import { Engine } from "./core/engine.js";
import { createPlatform, createPickup } from "./scene/prefab.js";
```

Build levels with prefabs, query with `world.query("transform", "mesh")`, save with `saveScene(world)`.
