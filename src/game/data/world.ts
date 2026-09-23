// UNDERCITY — original game data. All names, factions, NPCs, products,
// missions and story content are original creations for this game.

export type Quality = "POOR" | "NORMAL" | "PREMIUM";

export interface District {
  id: string;
  name: string;
  kind: string;
  center: [number, number];
  size: number;
  wealth: number; // 0..1 drives building height / color
  color: [number, number, number];
}

export const DISTRICTS: District[] = [
  { id: "core", name: "The Core", kind: "Downtown", center: [0, 0], size: 26, wealth: 1.0, color: [0.35, 0.38, 0.5] },
  { id: "mercer", name: "Mercer Row", kind: "Commercial", center: [34, 6], size: 24, wealth: 0.75, color: [0.45, 0.36, 0.28] },
  { id: "hightown", name: "Hightown", kind: "Wealthy residential", center: [-6, -36], size: 24, wealth: 0.85, color: [0.36, 0.44, 0.4] },
  { id: "cinder", name: "Cinder Park", kind: "Residential", center: [-36, 10], size: 24, wealth: 0.45, color: [0.42, 0.4, 0.33] },
  { id: "docks", name: "Old Docks", kind: "Warehouses", center: [8, 38], size: 26, wealth: 0.4, color: [0.33, 0.4, 0.45] },
  { id: "foundry", name: "Foundry Gate", kind: "Industrial", center: [38, -32], size: 26, wealth: 0.55, color: [0.45, 0.33, 0.28] },
  { id: "rust", name: "Rust Flats", kind: "Poor neighborhoods", center: [-38, -30], size: 24, wealth: 0.2, color: [0.4, 0.32, 0.27] },
];

export interface Faction {
  id: string;
  name: string;
  desc: string;
  startingRel: number; // -100..100 toward the empire
}

export const FACTIONS: Faction[] = [
  { id: "halberd", name: "Halberd Construction", desc: "Major construction corporation. Sees you as a nuisance, then a threat.", startingRel: -10 },
  { id: "ledger", name: "The Pale Ledger", desc: "Underground syndicate that keeps the hidden economy's books.", startingRel: 0 },
  { id: "ironwright", name: "Ironwright Union", desc: "Independent contractors who respect honest work.", startingRel: 15 },
  { id: "glass", name: "The Glass Index", desc: "Information broker network. Everything has a price.", startingRel: 0 },
  { id: "dockside", name: "Dockside Collective", desc: "Local business owners around Old Docks.", startingRel: 10 },
  { id: "ashfall", name: "Ashfall Foundry", desc: "Industrial combine selling heavy materials, no questions asked.", startingRel: 0 },
];

// Fictional, abstracted goods. Production is an abstract batch process:
// materials -> refine (time) -> package -> stock -> sell. No real-world referents.
export interface Product {
  id: string;
  name: string;
  desc: string;
  basePrice: number; // NORMAL quality reference price per unit
}

export const PRODUCTS: Product[] = [
  { id: "lumen", name: "Lumen", desc: "Fictional luminescent compound, refined from salvaged flare stock.", basePrice: 45 },
  { id: "halo", name: "Halo", desc: "Fictional aromatic resin, blended for underground markets.", basePrice: 70 },
  { id: "ferrite", name: "Ferrite", desc: "Fictional treated alloy used in off-book fabrication.", basePrice: 110 },
];

export const QUALITY_MULT: Record<Quality, number> = { POOR: 0.6, NORMAL: 1.0, PREMIUM: 1.7 };

export interface NPCDef {
  id: string;
  name: string;
  role: string;
  district: string;
  recruitable: boolean;
  stats: { construction: number; logistics: number; management: number; production: number; driving: number; reliability: number; loyalty: number; efficiency: number; salary: number };
  blurb: string;
}

export const NPCS: NPCDef[] = [
  { id: "bram", name: "Bram Kessler", role: "Foreman", district: "Rust Flats", recruitable: true, stats: { construction: 8, logistics: 4, management: 5, production: 4, driving: 3, reliability: 8, loyalty: 7, efficiency: 7, salary: 12 }, blurb: "A retired site foreman who knows every crew in the Flats." },
  { id: "vesper", name: "Vesper Quill", role: "Broker", district: "Mercer Row", recruitable: false, stats: { construction: 2, logistics: 6, management: 7, production: 3, driving: 2, reliability: 5, loyalty: 4, efficiency: 8, salary: 0 }, blurb: "A market broker with a ledger full of favors owed." },
  { id: "odell", name: "Odell Marsh", role: "Supplier", district: "Old Docks", recruitable: true, stats: { construction: 3, logistics: 9, management: 4, production: 5, driving: 6, reliability: 7, loyalty: 6, efficiency: 7, salary: 14 }, blurb: "Runs dockside storage and never loses a manifest." },
  { id: "junie", name: "Junie Park", role: "Mechanic", district: "Foundry Gate", recruitable: true, stats: { construction: 5, logistics: 4, management: 3, production: 6, driving: 8, reliability: 7, loyalty: 6, efficiency: 7, salary: 13 }, blurb: "Keeps engines alive that should have died years ago." },
  { id: "ines", name: "Ines Halvorsen", role: "Councilor", district: "Hightown", recruitable: false, stats: { construction: 1, logistics: 3, management: 8, production: 1, driving: 1, reliability: 6, loyalty: 3, efficiency: 5, salary: 0 }, blurb: "A city councilor who trades permits for goodwill." },
  { id: "corvin", name: "Corvin Hale", role: "Halberd Executive", district: "The Core", recruitable: false, stats: { construction: 4, logistics: 5, management: 9, production: 2, driving: 1, reliability: 4, loyalty: 2, efficiency: 8, salary: 0 }, blurb: "Halberd's smiling hammer. He does not like competition." },
];

export interface CustomerDef {
  id: string;
  name: string;
  personality: string;
  income: "LOW" | "MEDIUM" | "HIGH";
  preferredQuality: Quality;
  preferredPrice: number; // per unit, NORMAL reference
  priceSensitivity: "HIGH" | "MEDIUM" | "LOW";
  patience: number; // 0..100
}

export const CUSTOMERS: CustomerDef[] = [
  { id: "mabel", name: "Mabel Crumb", personality: "Thrifty regular", income: "LOW", preferredQuality: "POOR", preferredPrice: 30, priceSensitivity: "HIGH", patience: 70 },
  { id: "dario", name: "Dario Venn", personality: "Steady middleman", income: "MEDIUM", preferredQuality: "NORMAL", preferredPrice: 62, priceSensitivity: "MEDIUM", patience: 55 },
  { id: "petra", name: "Petra Voss", personality: "Demanding collector", income: "HIGH", preferredQuality: "PREMIUM", preferredPrice: 120, priceSensitivity: "LOW", patience: 40 },
];

export interface PropertyDef {
  id: string;
  name: string;
  desc: string;
  cost: number;
  incomePerSec: number; // level 1; x2 at lv2, x3 at lv3
  upgradeCost: number; // per level
  minAct: number;
  color: [number, number, number];
}

export const PROPERTIES: PropertyDef[] = [
  { id: "office", name: "Field Office", desc: "A rented room above a laundromat. Legit on paper.", cost: 800, incomePerSec: 0.6, upgradeCost: 600, minAct: 1, color: [0.5, 0.45, 0.35] },
  { id: "garage", name: "Lockup Garage", desc: "Shared garage for empire vehicles.", cost: 1500, incomePerSec: 0.8, upgradeCost: 1100, minAct: 2, color: [0.4, 0.42, 0.5] },
  { id: "warehouse", name: "Dockside Warehouse", desc: "Storage for materials, crates and quiet business.", cost: 3500, incomePerSec: 1.6, upgradeCost: 2600, minAct: 2, color: [0.45, 0.4, 0.33] },
  { id: "shop", name: "Mercer Shopfront", desc: "A legal storefront that moves product-adjacent goods.", cost: 5200, incomePerSec: 2.4, upgradeCost: 3800, minAct: 3, color: [0.5, 0.38, 0.3] },
  { id: "factory", name: "Foundry Workshop", desc: "Small factory for refining and packaging.", cost: 8000, incomePerSec: 3.6, upgradeCost: 6000, minAct: 4, color: [0.42, 0.36, 0.36] },
  { id: "apartments", name: "Cinder Apartments", desc: "Rental block. Steady money, steady eyes.", cost: 6500, incomePerSec: 2.8, upgradeCost: 4800, minAct: 4, color: [0.4, 0.44, 0.4] },
];

export interface VehicleDef {
  id: string;
  name: string;
  kind: "Car" | "Van" | "Truck" | "Construction" | "Utility" | "Board";
  cost: number;
  speedBonus: number; // additive to player drive speed
}

export const VEHICLES: VehicleDef[] = [
  { id: "board", name: "Corner Board", kind: "Board", cost: 600, speedBonus: 0 },
  { id: "kestrel", name: "Kestrel Sedan", kind: "Car", cost: 900, speedBonus: 1.0 },
  { id: "mule", name: "Mule Van", kind: "Van", cost: 1400, speedBonus: 1.5 },
  { id: "hauler", name: "Hauler Truck", kind: "Truck", cost: 2600, speedBonus: 2.0 },
  { id: "piledriver", name: "Piledriver Rig", kind: "Construction", cost: 3200, speedBonus: 1.0 },
  { id: "sweeper", name: "Sweeper Utility", kind: "Utility", cost: 1100, speedBonus: 1.2 },
];

export interface ContractDef {
  id: string;
  name: string;
  tier: number; // ladder rung
  reward: number;
  rep: number;
  workTime: number; // seconds of hands-on work
  minAct: number;
  desc: string;
}

export const CONTRACTS: ContractDef[] = [
  { id: "repairs", name: "Small Repairs", tier: 1, reward: 150, rep: 1, workTime: 4, minAct: 1, desc: "Patch a roof in Rust Flats. Hands-on, honest pay." },
  { id: "renovation", name: "Renovation Job", tier: 2, reward: 300, rep: 2, workTime: 6, minAct: 1, desc: "Gut and refit a Cinder Park flat." },
  { id: "smallcontract", name: "Small Construction Contract", tier: 3, reward: 550, rep: 3, workTime: 8, minAct: 2, desc: "A Mercer Row kiosk extension." },
  { id: "warehousebuild", name: "Warehouse Build", tier: 4, reward: 900, rep: 4, workTime: 10, minAct: 2, desc: "Raise storage at Old Docks." },
  { id: "commercial", name: "Commercial Property", tier: 5, reward: 1300, rep: 5, workTime: 12, minAct: 3, desc: "Two floors of retail on Mercer Row." },
  { id: "factoryfit", name: "Factory Fit-Out", tier: 6, reward: 1700, rep: 6, workTime: 14, minAct: 4, desc: "Machine halls at Foundry Gate." },
  { id: "development", name: "City Development", tier: 7, reward: 2400, rep: 8, workTime: 16, minAct: 5, desc: "A whole block in The Core. Big crews, big eyes." },
];

export type MissionType = "talk" | "work" | "earn" | "buy" | "produce" | "sell" | "ownprops" | "rep" | "defend" | "finale";

export interface MissionDef {
  id: string;
  act: number;
  title: string;
  desc: string;
  type: MissionType;
  targetId?: string; // npc / contract / property / product / customer
  count?: number;
  amount?: number; // earn / rep thresholds
  rewardCash: number;
  rewardRep: number;
}

export const ACT_NAMES = ["", "ACT 1 — NOBODY", "ACT 2 — CONTRACTORS", "ACT 3 — THE UNDERGROUND", "ACT 4 — EMPIRE", "ACT 5 — EMPIRE WAR", "ACT 6 — KING OF THE CITY"];

export const MISSIONS: MissionDef[] = [
  { id: "a1m1", act: 1, title: "First Steps", desc: "Find Bram Kessler in Rust Flats and introduce yourself. (Walk to the gold marker, press E)", type: "talk", targetId: "bram", rewardCash: 50, rewardRep: 2 },
  { id: "a1m2", act: 1, title: "Patchwork", desc: "Complete 2 Small Repairs jobs. (Jobs menu, then work the site beacon)", type: "work", targetId: "repairs", count: 2, rewardCash: 100, rewardRep: 3 },
  { id: "a1m3", act: 1, title: "Seed Money", desc: "Hold $600 in your wallet at once through honest work.", type: "earn", amount: 600, rewardCash: 0, rewardRep: 3 },
  { id: "a2m1", act: 2, title: "A Name on the Door", desc: "Buy the Field Office with empire funds. (Deposit first — $10,000 fixed limit per deposit)", type: "buy", targetId: "office", rewardCash: 0, rewardRep: 4 },
  { id: "a2m2", act: 2, title: "Wheels", desc: "Buy an empire vehicle (any) from the garage.", type: "buy", targetId: "vehicle", rewardCash: 0, rewardRep: 3 },
  { id: "a2m3", act: 2, title: "Warehouse Years", desc: "Buy the Dockside Warehouse.", type: "buy", targetId: "warehouse", rewardCash: 0, rewardRep: 5 },
  { id: "a2m4", act: 2, title: "Three More Roofs", desc: "Complete 3 contracts of any kind.", type: "work", count: 3, rewardCash: 200, rewardRep: 5 },
  { id: "a3m1", act: 3, title: "The Backroom", desc: "Meet Vesper Quill on Mercer Row.", type: "talk", targetId: "vesper", rewardCash: 0, rewardRep: 3 },
  { id: "a3m2", act: 3, title: "First Batch", desc: "Refine one batch of product in the Biz menu.", type: "produce", rewardCash: 0, rewardRep: 2 },
  { id: "a3m3", act: 3, title: "First Handshake", desc: "Sell product to any customer.", type: "sell", rewardCash: 0, rewardRep: 4 },
  { id: "a4m1", act: 4, title: "Heavy Metal", desc: "Buy the Foundry Workshop.", type: "buy", targetId: "factory", rewardCash: 0, rewardRep: 6 },
  { id: "a4m2", act: 4, title: "Portfolio", desc: "Own 4 empire properties.", type: "ownprops", amount: 4, rewardCash: 300, rewardRep: 6 },
  { id: "a4m3", act: 4, title: "A Known Name", desc: "Reach 55 Empire Reputation.", type: "rep", amount: 55, rewardCash: 300, rewardRep: 0 },
  { id: "a5m1", act: 5, title: "Hold the Line", desc: "Halberd is sabotaging sites. Complete 2 City Developments or Commercial jobs under pressure.", type: "defend", count: 2, rewardCash: 400, rewardRep: 6 },
  { id: "a5m2", act: 5, title: "Terms", desc: "Confront Corvin Hale in The Core. Choose your words carefully.", type: "talk", targetId: "corvin", rewardCash: 0, rewardRep: 5 },
  { id: "a5m3", act: 5, title: "The Ledger's Price", desc: "Vesper calls in the favor. Pay $2,000 from the empire bank (Bank menu).", type: "earn", amount: -2000, rewardCash: 0, rewardRep: 5 },
  { id: "a6m1", act: 6, title: "The Last Contract", desc: "Complete one City Development.", type: "work", targetId: "development", count: 1, rewardCash: 500, rewardRep: 8 },
  { id: "a6m2", act: 6, title: "King of the City", desc: "Reach 80 Reputation with Heat below 40.", type: "finale", rewardCash: 1000, rewardRep: 0 },
];
