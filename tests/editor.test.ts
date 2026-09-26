import { describe, expect, it } from "vitest";
import { History, type Command } from "../src/editor/history.js";
import {
  axisParam, distPointToSegment2D, screenRay, snapValue, unproject,
  viewProj, worldToScreen,
} from "../src/editor/gizmo.js";
import { Mat4 } from "../src/math/mat4.js";
import { Vec3 } from "../src/math/vec3.js";

describe("History", () => {
  it("does, undoes and redoes in LIFO order", () => {
    const h = new History();
    let v = 0;
    const inc = (n: number, label: string): Command => ({
      label,
      do: () => { v += n; },
      undo: () => { v -= n; },
    });
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
    h.execute(inc(1, "one"));
    h.execute(inc(10, "ten"));
    expect(v).toBe(11);
    expect(h.labels()).toEqual(["one", "ten"]);
    expect(h.undo()).toBe("ten");
    expect(v).toBe(1);
    expect(h.redo()).toBe("ten");
    expect(v).toBe(11);
    expect(h.depth).toBe(2);
    expect(h.redoDepth).toBe(0);
  });

  it("truncates redo on new work and caps depth", () => {
    const h = new History(2);
    let v = 0;
    const set = (n: number): Command => ({
      label: `set${n}`,
      do: () => { v = n; },
      undo: () => { v = 0; },
    });
    h.execute(set(1));
    h.execute(set(2));
    h.undo();
    h.execute(set(3)); // redo stack cleared
    expect(h.canRedo()).toBe(false);
    expect(v).toBe(3);
    h.execute(set(4));
    h.execute(set(5)); // cap 2: oldest dropped
    expect(h.depth).toBe(2);
    expect(h.labels()).toEqual(["set4", "set5"]);
    h.clear();
    expect(h.canUndo()).toBe(false);
  });
});

function testVP() {
  const view = Mat4.lookAt(new Vec3(0, 0, 5), new Vec3(0, 0, 0), Vec3.up());
  const proj = Mat4.perspective(Math.PI / 3, 1, 0.1, 100);
  return viewProj(view, proj);
}

describe("gizmo projection", () => {
  it("projects the look target to canvas center", () => {
    const s = worldToScreen(testVP(), 800, 600, new Vec3(0, 0, 0));
    expect(s.behind).toBe(false);
    expect(s.x).toBeCloseTo(400, 0);
    expect(s.y).toBeCloseTo(300, 0);
  });

  it("flags points behind the camera", () => {
    const s = worldToScreen(testVP(), 800, 600, new Vec3(0, 0, 10));
    expect(s.behind).toBe(true);
  });

  it("unprojects back to the source point", () => {
    const vp = testVP();
    const src = new Vec3(1.5, -0.5, -2);
    const s = worldToScreen(vp, 800, 600, src);
    expect(s.behind).toBe(false);
    const nx = (s.x / 800) * 2 - 1;
    const ny = 1 - (s.y / 600) * 2;
    // march along the ray: some t must land back on src
    const inv = vp.invert()!;
    const near = unproject(vp, nx, ny, -1)!;
    const far = unproject(vp, nx, ny, 1)!;
    void inv;
    // src lies on the near->far segment
    const d1 = far.clone().sub(near).length();
    const d2 = src.clone().sub(near).length() + far.clone().sub(src).length();
    expect(d2).toBeCloseTo(d1, 3);
  });

  it("casts center rays straight down -z", () => {
    const ray = screenRay(testVP(), 800, 600, 400, 300)!;
    expect(ray.dir.z).toBeCloseTo(-1, 4);
    expect(Math.abs(ray.dir.x)).toBeLessThan(1e-4);
  });
});

describe("axisParam", () => {
  it("measures along-axis distance for a side view", () => {
    // Ray along -z at x=0; X axis through origin: closest at axisT=0.
    const r = axisParam(new Vec3(0, 0, 5), new Vec3(0, 0, -1), new Vec3(0, 0, 0), new Vec3(1, 0, 0));
    expect(r).not.toBeNull();
    expect(r!.axisT).toBeCloseTo(0, 6);
    expect(r!.rayT).toBeCloseTo(5, 6);
  });

  it("tracks sliding along the axis", () => {
    // Ray straight down -z from (3,1,5): closest X-axis point is x=3 at rayT=5.
    const r = axisParam(new Vec3(3, 1, 5), new Vec3(0, 0, -1), new Vec3(0, 0, 0), new Vec3(1, 0, 0));
    expect(r).not.toBeNull();
    expect(r!.axisT).toBeCloseTo(3, 6);
    expect(r!.rayT).toBeCloseTo(5, 6);
  });

  it("returns null for (near-)parallel ray and axis", () => {
    const r = axisParam(new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(0, 0, 0), new Vec3(1, 0, 0));
    expect(r).toBeNull();
  });
});

describe("segment distance and snapping", () => {
  it("measures point-to-segment distance", () => {
    expect(distPointToSegment2D(5, 5, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(distPointToSegment2D(15, 0, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(distPointToSegment2D(3, 0, 0, 0, 10, 0)).toBeCloseTo(0);
  });

  it("snaps to steps, ignores non-positive steps", () => {
    expect(snapValue(1.3, 0.5)).toBe(1.5);
    expect(snapValue(1.1, 0.5)).toBe(1.0);
    expect(snapValue(1.3, 0)).toBe(1.3);
  });
});
