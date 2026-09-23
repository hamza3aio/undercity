# UNDERCITY — design & milestone record (original game)

Single-player milestone build on Glitch Game Engine (TypeScript/WebGL2).
All districts, factions, NPCs, products, missions and story are original.

## Honest scope note

- **Engine here is Glitch (web), not Unity.** No Unity editor or C# toolchain
  exists in this environment, so a Unity port cannot be compiled or verified here.
- **Online multiplayer is NOT included.** Real 10-player server-authoritative
  multiplayer needs dedicated server infrastructure that cannot be provisioned
  or tested from here, and faking it would violate the spec. Instead the whole
  shared-empire state lives in ONE serializable `EmpireSim`
  (`src/game/sim/sim.ts`) — the exact shape a future authoritative server
  would own — with rendering (`game.ts`) and UI (`ui.ts`) separated from it.
  Saves persist to localStorage. No fixed player roles exist; skills are
  free-form (9 tracks, no classes).

## How to play

WASD move · Space jump · mouse-drag orbit · E interact · R reset position.
Controller supported (left stick + A). Menubar or hotkeys:
Jobs(J) Bank(B) Props(P) Cars(V) People(N) Biz(U) You(C) Settings(G) Help(H).

Loop: take Jobs → work gold beacons (stay in radius) → earn → deposit
(fixed $10,000/deposit, never scales) → buy empire properties/vehicles →
Act 3 opens the backroom (refine fictional batches Lumen/Halo/Ferrite in
POOR/NORMAL/PREMIUM, sell to customers by taste) → story through 6 acts →
EMPIRE MODE endless. Drive the orange truck (E), haul crates from the
warehouse pile, talk to NPCs (E) to raise relationships, recruit at 70+,
watch Heat (production/sales raise it, laying low cools it).

## Spec coverage (this milestone)

- Shared empire: bank/rep/vehicles/properties/businesses/employees/factions — one EmpireSim ✓
- Wallet + empire bank, fixed $10,000 deposit limit, >$5,000 spends need confirm ✓
- Reputation 0–100 shared, drives missions/prices/recruitment ✓
- Empire + personal vehicles, garage, drivable truck, persistent via save ✓
- 6 properties, buy/upgrade, visuals grow + recolor per level ✓
- Construction ladder 7 tiers, hands-on beacon work, deliveries, city reacts ✓
- Fictional goods only (Lumen/Halo/Ferrite), abstract refine→package→sell ✓
- Customers with quality/price/patience profiles + 0–100 satisfaction bands ✓
- Relationships 0–100 with 5 stages, dialogue choices, gifts-via-tribute ✓
- Recruitment at 70+, 9 stats, salaries, satisfaction, assignments boost income ✓
- 6 acts / 18 missions, co-op-shaped objectives, EMPIRE MODE endless + events ✓
- 7 districts, Heat 0–100 with tiers/decay/raids, 6 original factions ✓
- 9 free-form skills, localStorage saves (player+empire), settings presets ✓
- UI: Play/Bank/Props/Cars/People/Biz/You/Missions(objective)/Settings ✓
  (No separate Map/Inventory screens yet — inventory is wallet/materials/crates/stock in You/Biz panels.)

## Milestones

- [x] M1: third-person character, camera, movement, customization, city test env
- [x] M3–M8 (single-player core): bank, vehicles, properties, construction, NPCs, employees, business, factions, rep, heat
- [x] M9–M10 (single-player): story campaign + Empire Mode endgame
- [ ] M2: real online multiplayer (needs server stack — future work)
- [ ] M11: optimization/balance pass (future work)
