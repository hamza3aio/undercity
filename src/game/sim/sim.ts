import {
  CONTRACTS, CUSTOMERS, FACTIONS, MISSIONS, NPCS, PROPERTIES, QUALITY_MULT, VEHICLES,
  type MissionDef, type Quality,
} from "../data/world.js";
import { ADDITIVES, MATERIAL_PRICE, REFINE_FEE, RUNNER_CUT, RUNNER_INTERVAL, RUNNER_UNITS, DAY_LENGTH_SEC } from "../data/street.js";

// Net-note: EmpireSim is the entire shared world state in ONE serializable
// object — the exact shape a future authoritative server would own and
// replicate. Presentation (game.ts) and UI (ui.ts) never mutate it except
// through these methods. LocalAdapter (localStorage) is the only
// persistence backend wired up; online multiplayer is NOT implemented.

export const DEPOSIT_LIMIT = 10000; // fixed per deposit, identical for every player, never scales
export const BIG_SPEND_CONFIRM = 5000; // empire spends above this need explicit confirm

export interface SkillSet { business: number; construction: number; driving: number; negotiation: number; combat: number; logistics: number; leadership: number; social: number; management: number; }
export type SkillKey = keyof SkillSet;
export interface Character { name: string; body: [number, number, number]; accent: [number, number, number]; hat: boolean; }
export interface StockBatch { product: string; label: string; quality: Quality; units: number; }
export interface Employee { npcId: string; salary: number; satisfaction: number; loyalty: number; assigned: string | null; }
export interface OwnedVehicle { id: string; owner: "empire" | "player"; condition: number; }

export interface SimState {
  v: number;
  wallet: number; bank: number; rep: number; heat: number;
  timeMin: number; day: number;
  stash: Record<string, number>; // propertyId -> stashed cash (safe from busts)
  runnerTimer: number;
  materials: number; crates: number;
  skills: SkillSet; xp: Record<SkillKey, number>;
  character: Character; customized: boolean;
  props: Record<string, number>; // propertyId -> level (0 = unowned)
  vehicles: OwnedVehicle[];
  employees: Employee[];
  rel: Record<string, number>; // npcId -> 0..100
  sat: Record<string, number>; // customerId -> 0..100
  stock: StockBatch[];
  factions: Record<string, number>; // factionId -> -100..100
  missions: Record<string, number>; // missionId -> progress count
  doneMissions: string[];
  act: number; empireMode: boolean;
  stats: { earned: number; contracts: number; sales: number; produced: number };
  log: string[];
}

export interface OpResult { ok: boolean; msg: string; needConfirm?: boolean; }

const SKILLS: SkillKey[] = ["business", "construction", "driving", "negotiation", "combat", "logistics", "leadership", "social", "management"];

export function freshState(): SimState {
  const rel: Record<string, number> = {};
  for (const n of NPCS) rel[n.id] = 5;
  const sat: Record<string, number> = {};
  for (const c of CUSTOMERS) sat[c.id] = 50;
  const factions: Record<string, number> = {};
  for (const f of FACTIONS) factions[f.id] = f.startingRel;
  const skills = {} as SkillSet; const xp = {} as Record<SkillKey, number>;
  for (const s of SKILLS) { skills[s] = 1; xp[s] = 0; }
  return {
    v: 2, wallet: 200, bank: 0, rep: 0, heat: 0,
    timeMin: 20 * 60, day: 1, stash: {}, runnerTimer: RUNNER_INTERVAL,
    materials: 0, crates: 0,
    skills, xp,
    character: { name: "Nobody", body: [0.2, 0.5, 1.0], accent: [1.0, 0.75, 0.2], hat: false },
    customized: false, props: {}, vehicles: [], employees: [],
    rel, sat, stock: [], factions, missions: {}, doneMissions: [],
    act: 1, empireMode: false,
    stats: { earned: 0, contracts: 0, sales: 0, produced: 0 },
    log: ["You arrive in the city with $200 and a borrowed toolbox."],
  };
}

export function fairFor(batch: { quality: Quality }, customerId: string): number {
  const cust = CUSTOMERS.find((c) => c.id === customerId);
  if (!cust) return 0;
  return Math.round(cust.preferredPrice * QUALITY_MULT[batch.quality]);
}

export function relStage(r: number): string {
  if (r >= 81) return "Loyal";
  if (r >= 61) return "Trusted";
  if (r >= 41) return "Contact";
  if (r >= 21) return "Acquaintance";
  return "Stranger";
}

export function satLabel(s: number): string {
  if (s >= 80) return "Very Happy / Loyal";
  if (s >= 60) return "Happy";
  if (s >= 40) return "Neutral";
  if (s >= 20) return "Unhappy";
  return "Extremely Unhappy";
}

export function heatLabel(h: number): string {
  if (h >= 90) return "CRACKDOWN";
  if (h >= 70) return "High";
  if (h >= 40) return "Medium";
  return "Low";
}

export class EmpireSim {
  s: SimState;
  private eventTimer = 45;
  private saveTimer = 0;
  onEvent: ((text: string) => void) | null = null;

  constructor(state?: SimState) { this.s = state ?? freshState(); }

  log(text: string) {
    this.s.log.unshift(text);
    if (this.s.log.length > 40) this.s.log.length = 40;
    this.onEvent?.(text);
  }

  currentMissions(): MissionDef[] {
    return MISSIONS.filter((m) => !this.s.doneMissions.includes(m.id) && (m.act === this.s.act || (this.s.empireMode && m.act === 6)));
  }

  // ---- skills ----
  gainXp(skill: SkillKey, amount: number) {
    const s = this.s;
    s.xp[skill] += amount;
    const need = s.skills[skill] * 100;
    if (s.xp[skill] >= need) {
      s.xp[skill] -= need;
      s.skills[skill] = Math.min(10, s.skills[skill] + 1);
      this.log(`Skill up: ${skill} → ${s.skills[skill]}`);
    }
  }

  // ---- money ----
  earn(amount: number, reason: string) {
    this.s.wallet = Math.round((this.s.wallet + amount) * 100) / 100;
    this.s.stats.earned = Math.round((this.s.stats.earned + amount) * 100) / 100;
    this.log(`+$${amount} wallet — ${reason}`);
    this.checkMissions();
  }

  deposit(amount: number): OpResult {
    amount = Math.floor(amount);
    if (amount <= 0) return { ok: false, msg: "Enter a positive amount." };
    if (amount > DEPOSIT_LIMIT) return { ok: false, msg: `Deposit limit is $${DEPOSIT_LIMIT.toLocaleString()} per deposit — fixed for everyone, never scales with rank.` };
    if (amount > this.s.wallet) return { ok: false, msg: "Insufficient wallet funds." };
    this.s.wallet -= amount; this.s.bank += amount;
    this.log(`Deposited $${amount.toLocaleString()} to the empire bank.`);
    this.gainXp("business", 4);
    return { ok: true, msg: `Deposited $${amount.toLocaleString()}.` };
  }

  withdraw(amount: number): OpResult {
    amount = Math.floor(amount);
    if (amount <= 0) return { ok: false, msg: "Enter a positive amount." };
    if (amount > this.s.bank) return { ok: false, msg: "Empire bank is short." };
    this.s.bank -= amount; this.s.wallet += amount;
    this.log(`Withdrew $${amount.toLocaleString()} from the empire bank.`);
    return { ok: true, msg: `Withdrew $${amount.toLocaleString()}.` };
  }

  private empireDebit(amount: number, purpose: string): OpResult {
    if (amount > this.s.bank) return { ok: false, msg: `Empire bank short ($${this.s.bank.toLocaleString()} available).` };
    this.s.bank = Math.round((this.s.bank - amount) * 100) / 100;
    this.log(`-$${amount.toLocaleString()} empire — ${purpose}`);
    return { ok: true, msg: "Paid." };
  }

  // ---- properties ----
  propertyLevel(id: string): number { return this.s.props[id] ?? 0; }
  ownedProps(): number { return Object.values(this.s.props).filter((l) => l > 0).length; }

  buyProperty(id: string, confirmed: boolean): OpResult {
    const def = PROPERTIES.find((p) => p.id === id);
    if (!def || this.s.act < def.minAct) return { ok: false, msg: "Not available yet." };
    if (this.propertyLevel(id) > 0) return { ok: false, msg: "Already owned." };
    if (def.cost > BIG_SPEND_CONFIRM && !confirmed) return { ok: false, msg: `Spend $${def.cost.toLocaleString()}?`, needConfirm: true };
    const r = this.empireDebit(def.cost, def.name);
    if (!r.ok) return r;
    this.s.props[id] = 1;
    this.addRep(3, `Acquired ${def.name}`);
    this.gainXp("business", 20); this.gainXp("management", 10);
    this.bumpMission("buy", id);
    this.log(`${def.name} is now empire property.`);
    return { ok: true, msg: `${def.name} purchased.` };
  }

  upgradeProperty(id: string, confirmed: boolean): OpResult {
    const def = PROPERTIES.find((p) => p.id === id);
    const lv = this.propertyLevel(id);
    if (!def || lv === 0) return { ok: false, msg: "Not owned." };
    if (lv >= 3) return { ok: false, msg: "Fully upgraded." };
    const cost = def.upgradeCost * lv;
    if (cost > BIG_SPEND_CONFIRM && !confirmed) return { ok: false, msg: `Spend $${cost.toLocaleString()}?`, needConfirm: true };
    const r = this.empireDebit(cost, `${def.name} renovation Lv${lv + 1}`);
    if (!r.ok) return r;
    this.s.props[id] = lv + 1;
    this.addRep(2, "Renovation completed");
    this.log(`${def.name} upgraded to level ${lv + 1} — visibly expanded.`);
    return { ok: true, msg: "Upgraded." };
  }

  // ---- vehicles ----
  buyVehicle(id: string, owner: "empire" | "player", confirmed: boolean): OpResult {
    const def = VEHICLES.find((v) => v.id === id);
    if (!def) return { ok: false, msg: "Unknown vehicle." };
    if (def.cost > BIG_SPEND_CONFIRM && !confirmed) return { ok: false, msg: `Spend $${def.cost.toLocaleString()}?`, needConfirm: true };
    if (owner === "empire") {
      const r = this.empireDebit(def.cost, def.name);
      if (!r.ok) return r;
    } else {
      if (def.cost > this.s.wallet) return { ok: false, msg: "Insufficient wallet funds." };
      this.s.wallet -= def.cost;
    }
    this.s.vehicles.push({ id, owner, condition: 100 });
    this.addRep(1, `New ${owner} vehicle: ${def.name}`);
    this.bumpMission("buy", "vehicle");
    this.log(`${def.name} (${def.kind}) registered to ${owner === "empire" ? "the EMPIRE — all players may use it" : "you personally"}.`);
    return { ok: true, msg: `${def.name} purchased.` };
  }

  // ---- contracts ----
  completeContract(id: string): OpResult {
    const def = CONTRACTS.find((c) => c.id === id);
    if (!def) return { ok: false, msg: "Unknown contract." };
    const constrBonus = 1 + (this.s.skills.construction - 1) * 0.04;
    const pay = Math.round(def.reward * constrBonus);
    this.s.stats.contracts++;
    this.earn(pay, def.name);
    this.addRep(def.rep, def.name);
    this.gainXp("construction", 18); this.gainXp("logistics", 6);
    this.bumpMission("work", id, 1);
    this.bumpMission("work", undefined, 1); // generic counters (a2m4 etc.)
    this.s.factions["ironwright"] = Math.min(100, this.s.factions["ironwright"] + 1);
    return { ok: true, msg: `Contract complete: +$${pay}.` };
  }

  // ---- underground (abstract batch process) ----
  buyMaterials(n: number): OpResult {
    n = Math.floor(n);
    if (n <= 0) return { ok: false, msg: "Enter a positive amount." };
    const hasOdell = this.s.employees.some((e) => e.npcId === "odell");
    const price = (hasOdell ? MATERIAL_PRICE - 2 : MATERIAL_PRICE) * n;
    if (price > this.s.wallet) return { ok: false, msg: `Need $${price} in wallet.` };
    this.s.wallet -= price;
    this.s.materials += n;
    this.gainXp("logistics", 6);
    this.log(`Bought ${n}u materials for $${price}${hasOdell ? " (Odell discount)" : ""}.`);
    return { ok: true, msg: `+${n}u materials.` };
  }

  produce(productId: string, quality: Quality): OpResult {
    const units = quality === "PREMIUM" ? 4 : quality === "NORMAL" ? 8 : 14;
    const fee = REFINE_FEE[quality];
    if (this.propertyLevel("warehouse") === 0 && this.propertyLevel("factory") === 0)
      return { ok: false, msg: "Need a warehouse or factory to refine batches." };
    if (this.s.materials < units) return { ok: false, msg: `Need ${units}u materials (have ${this.s.materials}). Buy from the supplier in Biz.` };
    if (fee > this.s.wallet) return { ok: false, msg: `Refining fee is $${fee} (wallet).` };
    this.s.materials -= units;
    this.s.wallet -= fee;
    this.s.stock.push({ product: productId, label: productId, quality, units });
    this.s.stats.produced += units;
    this.addHeat(6, "refining");
    this.gainXp("management", 12);
    this.bumpMission("produce", undefined, 1);
    this.log(`Refined ${units}u ${quality} ${productId} (abstract batch process).`);
    return { ok: true, msg: `Batch ready: ${units}u ${quality}.` };
  }

  mixBatch(batchIndex: number, additiveId: string, name: string): OpResult {
    const base = this.s.stock[batchIndex];
    if (!base) return { ok: false, msg: "No such batch." };
    const add = ADDITIVES.find((a) => a.id === additiveId);
    if (!add) return { ok: false, msg: "Unknown additive." };
    name = name.trim().slice(0, 18) || `${base.label}-${add.name}`;
    const mgmt = this.s.skills.management;
    const up = Math.min(0.6, add.up + mgmt * 0.01);
    const roll = Math.random();
    const order = { POOR: 0, NORMAL: 1, PREMIUM: 2 } as Record<Quality, number>;
    const names = ["POOR", "NORMAL", "PREMIUM"] as Quality[];
    let q = order[base.quality];
    if (roll < up) q = Math.min(2, q + 1);
    else if (roll > 1 - add.down) q = Math.max(0, q - 1);
    this.s.stock.splice(batchIndex, 1);
    this.s.stock.push({ product: base.product, label: name, quality: names[q], units: base.units });
    this.addHeat(3, "mixing");
    this.gainXp("management", 10);
    this.log(`Blended ${base.label} + ${add.name} → ${name} (${names[q]}).`);
    return { ok: true, msg: `${name} ready (${names[q]}).` };
  }

  sellTo(customerId: string, batchIndex: number, pricePerUnit: number): OpResult {
    const batch = this.s.stock[batchIndex];
    const cust = CUSTOMERS.find((c) => c.id === customerId);
    if (!batch || !cust) return { ok: false, msg: "Nothing to sell." };
    const qRank = { POOR: 0, NORMAL: 1, PREMIUM: 2 };
    const match = qRank[batch.quality] - qRank[cust.preferredQuality];
    const fair = cust.preferredPrice * QUALITY_MULT[batch.quality];
    const overpay = pricePerUnit / Math.max(1, fair);
    let delta = 0;
    if (match === 0) delta += 12;
    else if (match > 0) delta += 5; // better than expected: mild plus
    else delta -= 22; // worse than expected: heavy minus
    if (overpay <= 1.0) delta += 6;
    else if (overpay <= 1.25) delta -= 4;
    else delta -= 14;
    if (cust.priceSensitivity === "HIGH") delta += overpay <= 1.0 ? 4 : -8;
    if (cust.priceSensitivity === "LOW") delta += 3;
    delta += Math.round((this.s.rel[cust.id] ?? 50) / 25); // relationship softens
    const total = Math.round(pricePerUnit * batch.units);
    this.s.wallet += total;
    this.s.stats.sales += batch.units;
    this.s.stats.earned += total;
    const prev = this.s.sat[customerId] ?? 50;
    this.s.sat[customerId] = Math.max(0, Math.min(100, prev + delta));
    this.s.rel[customerId] = Math.max(0, Math.min(100, (this.s.rel[customerId] ?? 50) + (delta > 0 ? 2 : -1)));
    this.s.stock.splice(batchIndex, 1);
    this.addHeat(4, "street sale");
    this.addRep(delta > 0 ? 1 : -1, `Sale to ${cust.name}`);
    this.gainXp("negotiation", 12); this.gainXp("social", 8);
    this.bumpMission("sell", undefined, 1);
    this.log(`Sold ${batch.units}u ${batch.label} (${batch.quality}) to ${cust.name} for $${total} (satisfaction ${prev}→${this.s.sat[customerId]}).`);
    return { ok: true, msg: `Sold for $${total}.` };
  }

  // ---- NPCs ----
  talk(npcId: string, choice: number): OpResult {
    const rel = this.s.rel[npcId] ?? 0;
    const gains = [6, 4, 2][Math.min(2, Math.max(0, choice))];
    this.s.rel[npcId] = Math.max(0, Math.min(100, rel + gains));
    this.gainXp("social", 8); this.gainXp("negotiation", 4);
    if (npcId === "vesper") this.s.factions["ledger"] = Math.min(100, this.s.factions["ledger"] + 2);
    if (npcId === "corvin") this.s.factions["halberd"] = Math.min(100, this.s.factions["halberd"] + 3);
    if (npcId === "ines") this.addHeat(-4, "goodwill");
    this.bumpMission("talk", npcId, 1);
    this.log(`Talked with ${npcId} (+${gains} relationship → ${this.s.rel[npcId]}, ${relStage(this.s.rel[npcId])}).`);
    return { ok: true, msg: "Relationship improved." };
  }

  recruit(npcId: string): OpResult {
    const def = NPCS.find((n) => n.id === npcId);
    if (!def?.recruitable) return { ok: false, msg: "This NPC cannot be recruited." };
    if ((this.s.rel[npcId] ?? 0) < 70) return { ok: false, msg: `Need relationship 70+ (now ${this.s.rel[npcId] ?? 0}, ${relStage(this.s.rel[npcId] ?? 0)}).` };
    if (this.s.employees.some((e) => e.npcId === npcId)) return { ok: false, msg: "Already employed." };
    this.s.employees.push({ npcId, salary: def.stats.salary, satisfaction: 70, loyalty: def.stats.loyalty * 10, assigned: null });
    this.addRep(2, `Recruited ${def.name}`);
    this.log(`${def.name} joined the empire crew.`);
    return { ok: true, msg: `${def.name} hired.` };
  }

  assignEmployee(npcId: string, propId: string | null): OpResult {
    const e = this.s.employees.find((x) => x.npcId === npcId);
    if (!e) return { ok: false, msg: "Not an employee." };
    e.assigned = propId;
    this.log(`${npcId} assigned to ${propId ?? "reserve"}.`);
    return { ok: true, msg: "Assigned." };
  }

  // ---- rep / heat ----
  addRep(n: number, reason: string) {
    this.s.rep = Math.max(0, Math.min(100, this.s.rep + n));
    if (n !== 0) this.log(`Reputation ${n > 0 ? "+" : ""}${n} (${this.s.rep}) — ${reason}`);
    this.checkMissions();
  }

  addHeat(n: number, reason: string) {
    this.s.heat = Math.max(0, Math.min(100, this.s.heat + n));
    if (Math.abs(n) >= 3) this.log(`Heat ${n > 0 ? "+" : ""}${n} (${this.s.heat}) — ${reason}`);
  }

  // ---- missions ----
  bumpMission(type: string, targetId: string | undefined, n = 1) {
    for (const m of this.currentMissions()) {
      if (m.type !== (type as MissionDef["type"])) continue;
      if (m.targetId && targetId && m.targetId !== targetId) continue;
      this.s.missions[m.id] = (this.s.missions[m.id] ?? 0) + n;
    }
    this.checkMissions();
  }

  missionProgress(m: MissionDef): { text: string; done: boolean } {
    const s = this.s;
    switch (m.type) {
      case "talk": return { text: s.rel[m.targetId ?? ""] >= 5 + 1 ? "Done" : "Talk to them", done: (s.missions[m.id] ?? 0) > 0 };
      case "work": {
        const need = m.count ?? 1;
        const got = s.missions[m.id] ?? 0;
        return { text: `${Math.min(got, need)}/${need}`, done: got >= need };
      }
      case "earn": {
        if ((m.amount ?? 0) < 0) {
          const paid = s.missions[m.id] ?? 0;
          return { text: `$${paid}/$${Math.abs(m.amount ?? 0)} paid`, done: paid >= Math.abs(m.amount ?? 0) };
        }
        return { text: `Wallet $${Math.floor(s.wallet)}/$${m.amount}`, done: s.wallet >= (m.amount ?? 0) };
      }
      case "buy": return { text: m.targetId === "vehicle" ? `${s.vehicles.length} owned` : (s.props[m.targetId ?? ""] ? "Owned" : "Not owned"), done: m.targetId === "vehicle" ? s.vehicles.length > 0 : (s.props[m.targetId ?? ""] ?? 0) > 0 };
      case "produce": return { text: `${s.missions[m.id] ?? 0}/1 batches`, done: (s.missions[m.id] ?? 0) >= 1 };
      case "sell": return { text: `${s.missions[m.id] ?? 0}/1 sales`, done: (s.missions[m.id] ?? 0) >= 1 };
      case "ownprops": return { text: `${this.ownedProps()}/${m.amount}`, done: this.ownedProps() >= (m.amount ?? 0) };
      case "rep": return { text: `${s.rep}/${m.amount}`, done: s.rep >= (m.amount ?? 0) };
      case "defend": {
        const need = m.count ?? 2;
        const got = s.missions[m.id] ?? 0;
        return { text: `${Math.min(got, need)}/${need} defended`, done: got >= need };
      }
      case "finale": return { text: `Rep ${s.rep}/80, Heat ${Math.floor(s.heat)}/<40`, done: s.rep >= 80 && s.heat < 40 };
      default: return { text: "", done: false };
    }
  }

  checkMissions() {
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const m of this.currentMissions()) {
        if (!this.missionProgress(m).done) continue;
        this.s.doneMissions.push(m.id);
        if (m.rewardCash > 0) { this.s.wallet += m.rewardCash; this.s.stats.earned += m.rewardCash; }
        if (m.rewardRep > 0) this.s.rep = Math.min(100, this.s.rep + m.rewardRep);
        this.log(`Mission complete: ${m.title}${m.rewardCash ? ` (+$${m.rewardCash})` : ""}${m.rewardRep ? ` (+${m.rewardRep} rep)` : ""}`);
        const next = MISSIONS.find((x) => !this.s.doneMissions.includes(x.id) && x.act === m.act);
        if (!next) {
          if (m.act < 6) {
            this.s.act = m.act + 1;
            this.log(`${["", "ACT 1 — NOBODY", "ACT 2 — CONTRACTORS", "ACT 3 — THE UNDERGROUND", "ACT 4 — EMPIRE", "ACT 5 — EMPIRE WAR", "ACT 6 — KING OF THE CITY"][this.s.act]} begins.`);
          } else if (!this.s.empireMode) {
            this.s.empireMode = true;
            this.log("EMPIRE MODE unlocked — the city is yours. Endless expansion begins.");
          }
        }
        advanced = true;
        break;
      }
    }
  }

  payTribute(amount: number): OpResult {
    if (amount > this.s.bank) return { ok: false, msg: "Empire bank is short." };
    this.s.bank -= amount;
    this.s.missions["a5m3"] = (this.s.missions["a5m3"] ?? 0) + amount;
    this.s.factions["ledger"] = Math.min(100, this.s.factions["ledger"] + 10);
    this.addHeat(-10, "debts settled");
    this.log(`Paid $${amount} tribute to the Pale Ledger.`);
    this.checkMissions();
    return { ok: true, msg: "Tribute paid." };
  }

  // ---- stashes: per-property cash safe from busts ----
  stashCash(propId: string, amount: number): OpResult {
    amount = Math.floor(amount);
    if ((this.s.props[propId] ?? 0) === 0) return { ok: false, msg: "Property not owned." };
    if (amount <= 0 || amount > this.s.wallet) return { ok: false, msg: "Insufficient wallet funds." };
    this.s.wallet -= amount;
    this.s.stash[propId] = (this.s.stash[propId] ?? 0) + amount;
    this.log(`Stashed $${amount.toLocaleString()} at ${propId}.`);
    return { ok: true, msg: "Stashed." };
  }

  unstashCash(propId: string, amount: number): OpResult {
    amount = Math.floor(amount);
    const have = this.s.stash[propId] ?? 0;
    if (amount <= 0 || amount > have) return { ok: false, msg: "Stash is short." };
    this.s.stash[propId] = have - amount;
    this.s.wallet += amount;
    this.log(`Pulled $${amount.toLocaleString()} from the ${propId} stash.`);
    return { ok: true, msg: "Cash in hand." };
  }

  // ---- busted by the Wardens ----
  busted(): { stockLost: number; cashLost: number } {
    const s = this.s;
    const stockLost = s.stock.reduce((a, b) => a + b.units, 0);
    s.stock = [];
    const cashLost = Math.floor(s.wallet * 0.25);
    s.wallet -= cashLost;
    s.heat = 35;
    this.addRep(-4, "Busted by the Wardens");
    this.log(`BUSTED: Wardens seized ${stockLost}u stock and $${cashLost}. Stashed cash untouched.`);
    return { stockLost, cashLost };
  }

  // ---- tick: clock, income, heat decay, runners, events ----
  tick(dt: number) {
    const s = this.s;
    // clock: full day = DAY_LENGTH_SEC real seconds
    s.timeMin += dt * (24 * 60 / DAY_LENGTH_SEC);
    if (s.timeMin >= 24 * 60) {
      s.timeMin -= 24 * 60;
      s.day++;
      this.log(`Day ${s.day} breaks over the city.`);
    }
    let income = 0;
    for (const [id, lv] of Object.entries(s.props)) {
      const def = PROPERTIES.find((p) => p.id === id);
      if (!def || lv === 0) continue;
      const assigned = s.employees.filter((e) => e.assigned === id).length;
      income += def.incomePerSec * lv * (1 + assigned * 0.25);
    }
    let salaries = 0;
    for (const e of s.employees) {
      salaries += e.salary / 60;
      e.satisfaction = Math.max(0, Math.min(100, e.satisfaction + (e.assigned ? 0.05 : -0.02) * dt));
    }
    if (income > 0) s.bank = Math.round((s.bank + income * dt) * 100) / 100;
    if (salaries > 0) s.bank = Math.max(0, Math.round((s.bank - salaries * dt) * 100) / 100);
    const h = this.hour();
    const night = h >= 21 || h < 5;
    if (s.heat > 0) s.heat = Math.max(0, s.heat - (night ? 0.35 : 0.6) * dt);

    // runners: assigned employees sell stock on the street, keep a cut
    const runners = s.employees.filter((e) => e.assigned === "streets");
    if (runners.length > 0 && s.stock.length > 0) {
      s.runnerTimer -= dt;
      if (s.runnerTimer <= 0) {
        s.runnerTimer = RUNNER_INTERVAL;
        const batch = s.stock[0];
        const cust = CUSTOMERS[Math.floor(Math.random() * CUSTOMERS.length)];
        const units = Math.min(RUNNER_UNITS, batch.units);
        const price = Math.round(cust.preferredPrice * QUALITY_MULT[batch.quality] * 0.9);
        const gross = price * units;
        const cut = Math.round(gross * RUNNER_CUT);
        batch.units -= units;
        if (batch.units <= 0) s.stock.shift();
        s.wallet += gross - cut;
        s.stats.sales += units;
        s.stats.earned += gross - cut;
        this.addHeat(1, "runner sale");
        this.log(`Runner moved ${units}u ${batch.label} (+$${gross - cut} after cut).`);
      }
    } else {
      s.runnerTimer = Math.min(s.runnerTimer, RUNNER_INTERVAL);
    }

    this.eventTimer -= dt;
    if (this.eventTimer <= 0) {
      this.eventTimer = 50 + Math.random() * 40;
      this.fireEvent();
    }
  }

  private fireEvent() {
    const s = this.s;
    const roll = Math.random();
    if (s.heat >= 70 && roll < 0.45) {
      const fine = Math.min(s.bank, Math.round(s.bank * 0.08) + 200);
      s.bank -= fine;
      this.addRep(-3, "Inspection raid");
      this.log(`Enforcement inspection: fined $${fine}. Lay low to cool Heat.`);
    } else if (s.heat >= 90) {
      const fine = Math.min(s.bank, Math.round(s.bank * 0.15) + 500);
      s.bank -= fine;
      this.addRep(-5, "Crackdown");
      this.log(`CRACKDOWN: operations seized, fined $${fine}.`);
    } else if (roll < 0.2 && s.stats.sales > 0) {
      const bonus = 150 + Math.floor(Math.random() * 300);
      s.wallet += bonus;
      this.log(`Bulk order from a happy client: +$${bonus}.`);
    } else if (roll < 0.32) {
      s.materials += 4;
      this.log("Odell's contact drops off 4 crates of materials.");
    } else if (roll < 0.4 && s.empireMode) {
      this.addRep(2, "City festival");
      this.log("City festival: crowds everywhere, reputation +2.");
    }
  }

  hour(): number { return Math.floor(this.s.timeMin / 60) % 24; }

  clockText(): string {
    const h = Math.floor(this.s.timeMin / 60) % 24;
    const m = Math.floor(this.s.timeMin % 60);
    const night = h >= 21 || h < 5;
    return `Day ${this.s.day} — ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${night ? "Night" : "Day"}`;
  }

  // ---- persistence ----
  save() {
    try {
      localStorage.setItem("undercity-save-v1", JSON.stringify(this.s));
      this.log("Game saved.");
      return true;
    } catch { return false; }
  }

  load(): boolean {
    try {
      const raw = localStorage.getItem("undercity-save-v1");
      if (!raw) return false;
      const parsed = JSON.parse(raw) as SimState;
      if (parsed.v !== 2) return false; // old format: start fresh
      this.s = parsed;
      return true;
    } catch { return false; }
  }

  reset() { this.s = freshState(); }
}
