# UNDERCITY — design & milestone record (original game)

Single-player milestone build on Glitch Game Engine (TypeScript/WebGL2).
All districts, factions, NPCs, products, missions and story are original.
"Schedule-I-style" refers to structure only (night streets, hands-on deals,
benches, stashes, runners, patrols) — nothing copied from any existing game;
all goods stay fictional and abstracted.

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

## v0.2 — street loop (Schedule-I-style structure, original content)

- Day/night cycle (8-min days, HUD clock): buyers walk at night, heat cools faster by day, lamps + sky follow the hour
- First-person mode (F), lit windows, lamp posts, mixing bench at the warehouse
- Street deals: walk up to night buyers (E), sell FIFO at fair or haggle +20%; spotted deals spike heat
- Materials economy: buy from supplier ($10/u, $8 with Odell), refining consumes materials + fee
- Blending bench: base batch + Ash/Mint/Cinder/Volt additive → named blend, quality shifts with Management skill
- Property stashes: cash safe from busts; Warden patrols hunt at heat 55+, busts seize carried stock + 25% wallet
- Runners: assign crew to Streets, they move stock for a 20% cut; Corner Board on-foot speed; owned vehicles boost driving
- Phone-style UI slide-over, busted modal, reworked Help

## v0.3 — menu, loading, compass/hotbar, player-hosted P2P (structure inspired by modern survival-sim menus; all presentation original)

- Main menu (Continue/New Game/Settings/Credits/Quit) over a live orbiting city backdrop; version label
- Loading screen with staged progress + rotating tips
- HUD: compass strip from camera yaw, 8-slot hotbar (stock batches, keys 1–8 select deal batch), wallet chip, FPS readout
- Player-hosted online (serverless WebRTC, manual codes, no accounts/servers): host owns the sim, 500ms snapshots, 4Hz positions, guest action requests with responses, remote avatars, lobby panel (host/invite/accept/join/leave, 4 max), mission toasts forwarded
- Honest limits: host leaves = session ends; guests can't confirm >$5k spends (host buys); wallets are crew-shared this milestone; needs a real 2-machine test

## v0.4 — street-level city kit + atmosphere (engine upgrade; look inspired by modern survival-sim streets, all content original)

- Engine: distance fog in the lit shader (uFogColor/Near/Far), `sky.ts` dawn/day/dusk/night palette, 140-unit tiled ground, `citykit.ts` prop builders (houses, pines, poles + wire runs, shops with sign boards, gas-station canopy, parked cars, fences, piers, scaffolds, mountains, dashes, sidewalks, dumpsters, mailboxes, cones)
- UNDERCITY: Cinder Park suburb, Mercer commercial + fuels, Old Docks bay + pier, Foundry fenced site with frame, Rust shacks, power lines, lane markings, sun/moon disc tracking the clock
- Original names only; no copied brands, maps, or art

## Milestones

- [x] M1: third-person character, camera, movement, customization, city test env
- [x] M3–M8 (single-player core): bank, vehicles, properties, construction, NPCs, employees, business, factions, rep, heat
- [x] M9–M10 (single-player): story campaign + Empire Mode endgame
- [x] M2 (part 1): player-hosted P2P listen-server (WebRTC, manual codes, 4 max) — needs 2-machine test
- [ ] M2 (part 2): host migration, dedicated servers, anti-cheat (future work)
- [ ] M11: optimization/balance pass (future work)
