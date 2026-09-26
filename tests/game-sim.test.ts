import { describe, expect, it } from "vitest";
import { EmpireSim, freshState, DEPOSIT_LIMIT, BIG_SPEND_CONFIRM } from "../src/game/sim/sim.js";

describe("bank: fixed deposit limit", () => {
  it("rejects deposits over the fixed limit", () => {
    const sim = new EmpireSim();
    sim.s.wallet = 50000;
    const r = sim.deposit(DEPOSIT_LIMIT + 1);
    expect(r.ok).toBe(false);
    expect(sim.s.bank).toBe(0);
  });

  it("accepts exactly the limit and moves money", () => {
    const sim = new EmpireSim();
    sim.s.wallet = 12000;
    const r = sim.deposit(DEPOSIT_LIMIT);
    expect(r.ok).toBe(true);
    expect(sim.s.bank).toBe(DEPOSIT_LIMIT);
    expect(sim.s.wallet).toBe(2000);
  });

  it("rejects empty and unfunded deposits", () => {
    const sim = new EmpireSim();
    expect(sim.deposit(0).ok).toBe(false);
    expect(sim.deposit(-5).ok).toBe(false);
    expect(sim.deposit(500).ok).toBe(false); // wallet only 200
  });

  it("withdraws within the bank balance", () => {
    const sim = new EmpireSim();
    sim.s.bank = 300;
    expect(sim.withdraw(500).ok).toBe(false);
    const r = sim.withdraw(200);
    expect(r.ok).toBe(true);
    expect(sim.s.bank).toBe(100);
    expect(sim.s.wallet).toBe(400);
  });
});

describe("properties and big-spend guard", () => {
  it("buys the office with empire funds and gains rep", () => {
    const sim = new EmpireSim();
    sim.s.bank = 5000;
    const r = sim.buyProperty("office", true);
    expect(r.ok).toBe(true);
    expect(sim.propertyLevel("office")).toBe(1);
    expect(sim.ownedProps()).toBe(1);
    expect(sim.s.rep).toBeGreaterThan(0);
  });

  it("requires explicit confirmation above the big-spend line", () => {
    const sim = new EmpireSim();
    sim.s.bank = 20000;
    sim.s.act = 4;
    const unconfirmed = sim.buyProperty("factory", false);
    expect(unconfirmed.ok).toBe(false);
    expect(unconfirmed.needConfirm).toBe(true);
    expect(sim.propertyLevel("factory")).toBe(0);
    const confirmed = sim.buyProperty("factory", true);
    expect(confirmed.ok).toBe(true);
    expect(BIG_SPEND_CONFIRM).toBe(5000);
  });

  it("refuses unknown or locked properties", () => {
    const sim = new EmpireSim();
    sim.s.bank = 99999;
    expect(sim.buyProperty("moonbase", true).ok).toBe(false);
    expect(sim.buyProperty("factory", true).ok).toBe(false); // act 1 < minAct
  });
});

describe("skills, rep and heat", () => {
  it("levels skills at 100 xp per level", () => {
    const sim = new EmpireSim();
    sim.gainXp("business", 99);
    expect(sim.s.skills.business).toBe(1);
    sim.gainXp("business", 1);
    expect(sim.s.skills.business).toBe(2);
    expect(sim.s.xp.business).toBe(0);
  });

  it("clamps rep and heat to 0..100", () => {
    const sim = new EmpireSim();
    sim.addRep(500, "test");
    expect(sim.s.rep).toBe(100);
    sim.addRep(-500, "test");
    expect(sim.s.rep).toBe(0);
    sim.addHeat(500, "test");
    expect(sim.s.heat).toBe(100);
    sim.addHeat(-500, "test");
    expect(sim.s.heat).toBe(0);
  });

  it("talk raises relationships and completes the first mission", () => {
    const sim = new EmpireSim();
    expect(sim.s.act).toBe(1);
    const r = sim.talk("bram", 0);
    expect(r.ok).toBe(true);
    expect(sim.s.rel.bram).toBe(5 + 6);
    expect(sim.s.doneMissions).toContain("a1m1");
  });

  it("recruiting needs relationship 70+", () => {
    const sim = new EmpireSim();
    expect(sim.recruit("bram").ok).toBe(false);
    sim.s.rel.bram = 75;
    const r = sim.recruit("bram");
    expect(r.ok).toBe(true);
    expect(sim.recruit("bram").ok).toBe(false); // already employed
    expect(sim.recruit("vesper").ok).toBe(false); // not recruitable
  });

  it("fresh saves are versioned and save/load survives storage absence", () => {
    const sim = new EmpireSim(freshState());
    expect(sim.s.v).toBe(2);
    expect(sim.s.wallet).toBe(200);
    // headless Node has no localStorage: must not throw
    expect(sim.save()).toBe(false);
    expect(sim.load()).toBe(false);
  });
});
