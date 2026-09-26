// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "../src/ecs/world.js";
import { Vec3 } from "../src/math/vec3.js";
import { makeTransform } from "../src/ecs/components.js";
import type { MeshRef, Transform } from "../src/ecs/components.js";
import { EditorOverlay } from "../src/editor/overlay.js";

function setup() {
  document.body.innerHTML = `<div id="ui"></div>`;
  const root = document.getElementById("ui")!;
  const world = new World();
  const ed = new EditorOverlay(world, root, { addTex: () => undefined });
  if (!ed.visible) ed.toggle();
  return { world, ed, root };
}

function buttonStarting(root: HTMLElement, text: string): HTMLButtonElement {
  const btns = Array.from(root.querySelectorAll("button"));
  const found = btns.find((b) => (b.textContent ?? "").startsWith(text));
  if (!found) throw new Error(`button starting with "${text}" not found`);
  return found as HTMLButtonElement;
}

function addBoxEntity(world: World, x = 0): number {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, 0, 0));
  world.add<MeshRef>(e, "mesh", { meshId: "cube", color: [1, 0, 0] });
  return e;
}

describe("EditorOverlay commands", () => {
  let world: World;
  let ed: EditorOverlay;
  let root: HTMLElement;

  beforeEach(() => {
    ({ world, ed, root } = setup());
  });

  it("adds entities through buttons", () => {
    buttonStarting(root, "+ Box").click();
    expect(world.count()).toBe(1);
    expect(ed.historyDepth().undo).toBe(1);
    expect(ed.selected).toBeGreaterThanOrEqual(0);
  });

  it("undoes and redoes an add", () => {
    buttonStarting(root, "+ Static").click();
    expect(world.count()).toBe(1);
    buttonStarting(root, "Undo").click();
    expect(world.count()).toBe(0);
    buttonStarting(root, "Redo").click();
    expect(world.count()).toBe(1);
  });

  it("deletes with restore via undo (transform + mesh survive)", () => {
    const e = addBoxEntity(world, 3);
    ed.selected = e;
    ed.deleteSelected();
    expect(world.isAlive(e)).toBe(false);
    expect(ed.historyDepth().undo).toBe(1);
    buttonStarting(root, "Undo").click();
    const [restored] = world.query("mesh");
    expect(restored).toBeDefined();
    expect(world.get<Transform>(restored, "transform")!.position.x).toBe(3);
    expect(world.get<MeshRef>(restored, "mesh")!.color).toEqual([1, 0, 0]);
  });

  it("Ctrl+Z / Ctrl+Y drive history", () => {
    buttonStarting(root, "+ Box").click();
    expect(world.count()).toBe(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true }));
    expect(world.count()).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyY", ctrlKey: true, bubbles: true }));
    expect(world.count()).toBe(1);
  });

  it("inspector transform edits are undoable", () => {
    const e = addBoxEntity(world, 0);
    ed.selected = e;
    ed.update();
    const xInput = root.querySelector('input[title="pos.x"]') as HTMLInputElement;
    expect(xInput).not.toBeNull();
    xInput.value = "7";
    xInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(world.get<Transform>(e, "transform")!.position.x).toBe(7);
    buttonStarting(root, "Undo").click();
    expect(world.get<Transform>(e, "transform")!.position.x).toBe(0);
  });

  it("shows hierarchy entries and selection", () => {
    addBoxEntity(world);
    addBoxEntity(world);
    ed.update();
    expect(root.textContent).toContain("2 entities");
  });

  it("toggles snap and panel visibility", () => {
    const snap = buttonStarting(root, "Snap 0.5: on");
    snap.click();
    expect(snap.textContent).toBe("Snap 0.5: off");
    expect(ed.visible).toBe(true);
    ed.toggle();
    expect(ed.visible).toBe(false);
  });
});
