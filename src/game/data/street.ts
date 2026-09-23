// UNDERCITY — street-loop tuning data (original content).
// "Schedule-I-style" here means structure only (night streets, hands-on
// dealing, benches, stashes, runners, patrols). Nothing copied: all names,
// factions, goods and systems are original, goods stay fictional/abstract.

export interface Additive { id: string; name: string; desc: string; up: number; down: number; }

export const ADDITIVES: Additive[] = [
  { id: "ash", name: "Ash", desc: "Cheap grey cut. Volatile results.", up: 0.15, down: 0.3 },
  { id: "mint", name: "Mint", desc: "Stable green cut. Rarely ruins a batch.", up: 0.2, down: 0.05 },
  { id: "cinder", name: "Cinder", desc: "Strong red cut. Big swings.", up: 0.35, down: 0.25 },
  { id: "volt", name: "Volt", desc: "Rare amber cut. Usually improves.", up: 0.45, down: 0.1 },
];

export const NIGHT_START = 21;
export const NIGHT_END = 5;
export const DAY_LENGTH_SEC = 480; // one full day = 8 real minutes

export const RUNNER_CUT = 0.2;
export const RUNNER_INTERVAL = 40; // seconds between runner sales
export const RUNNER_UNITS = 4;

export const PATROL_MIN_HEAT = 55;
export const PATROL_SPEED = 4.5;
export const PATROL_GIVEUP = 25; // seconds before patrols lose you
export const BUST_IMMUNITY = 45; // seconds after a bust with no patrols

export const MATERIAL_PRICE = 10; // $/u, 8 if Odell works for you
export const REFINE_FEE = { POOR: 20, NORMAL: 60, PREMIUM: 120 } as const;

export const BOARD_ID = "board";

export function isNightHour(h: number): boolean {
  return h >= NIGHT_START || h < NIGHT_END;
}
