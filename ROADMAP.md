# Glitch Game Engine — Full Version Plan (v1.0)

## Phase 1 — Foundation (done, v0.1)
- `src/math/` Vec3, Mat4
- `src/core/` Time, GameLoop (fixed-step), Engine
- `src/ecs/` World, Transform/Rigidbody/BoxCollider/MeshRef/Spin/PlayerTag
- Demo in `src/main.ts`

## Phase 2 — Rendering Pro (this batch)
- `src/rendering/texture.ts` — procedural + image textures
- `src/rendering/material.ts` — color + texture + shininess
- `src/rendering/lights.ts` — ambient + directional + up to 4 point lights
- `src/rendering/obj.ts` — minimal OBJ parser → MeshData
- Upgrade `shader.ts` + `renderer.ts` — textured lit shader, multi-light uniforms, fallback for untextured meshes

## Phase 3 — Physics Pro
- `src/physics/raycast.ts` — Ray vs AABB, scene raycast
- `src/physics/trigger.ts` — Trigger volumes + enter/exit events
- `src/physics/character.ts` — CharacterController helper (move, jump, grounding)
- Extend `physics.ts` — layers/masks (lightweight), trigger pass

## Phase 4 — Gameplay Framework
- `src/scene/scene.ts` — save/load scene JSON
- `src/scene/prefab.ts` — createBox/Platform/Pickup/Trigger helpers
- `src/input/actions.ts` — action mapping (move/jump) over raw Input
- `src/ui/hud.ts` — HUD helper (fps line, center message)

## Phase 5 — Audio Pro
- Extend `src/audio/audio.ts` — positional blips, music loop, SFX pool (back-compat `blip/jump/land/pickup` kept)

## Phase 6 — Assets, Editor, Examples
- `src/assets/loader.ts` — loadTexture/loadOBJ/loadJSON with cache
- `src/editor/overlay.ts` — DOM hierarchy + inspector + play/pause + scene save/load
- `src/examples/` — keep `main.ts` demo; add `examples/second-level.ts` data
- Docs: README modules + controls + authoring guide

Acceptance: `npx tsc --noEmit` + `npx vite build` pass, demo still playable, new APIs usable from `main.ts` without breaking old components.
