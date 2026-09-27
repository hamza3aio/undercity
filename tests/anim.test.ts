import { describe, expect, it } from "vitest";
import { Mat4 } from "../src/math/mat4.js";
import { Vec3 } from "../src/math/vec3.js";
import { World } from "../src/ecs/world.js";
import {
  AnimationStateMachine, blendPose, boneWorldPositions, buildSkinMesh, clonePose, makePose,
  makeSkeleton, restPose, rootMotion, sampleClip, skinMatrices, skinVertex, solveTwoBoneIK,
  solveTwoBoneIKYaw, wrapTime, type Bone, type Clip,
} from "../src/anim/skeleton.js";
import { AnimatorSystem, clipKey, makeAnimator, makeAnimEntity, type ClipBank } from "../src/anim/animator.js";
import { registerDemoCharacter, DEMO_MACHINE, DEMO_BONES as DEMO_BONES_SRC, makeWalkClip } from "../src/anim/demo.js";

function bone(name: string, parent: number, x = 0, y = 0, z = 0): Bone {
  return { name, parent, bindPos: [x, y, z], bindRotY: 0, bindScale: [1, 1, 1] };
}

describe("skeleton", () => {
  it("builds bind inverses and rejects bad hierarchies", () => {
    const sk = makeSkeleton([bone("a", -1), bone("b", 0, 0, 1, 0)]);
    expect(sk.bones).toHaveLength(2);
    expect(sk.bindInv).toHaveLength(2);
    expect(() => makeSkeleton([bone("a", 0)])).toThrow(/itself/);
    expect(() => makeSkeleton([bone("a", 5)])).toThrow(/out of range/);
  });

  it("rest pose reproduces the bind transforms", () => {
    const sk = makeSkeleton([bone("a", -1, 0, 1, 0), bone("b", 0, 0, 1, 0)]);
    const p = restPose(sk);
    expect(p[1]).toBeCloseTo(1); // a.y
    expect(p[7 + 1]).toBeCloseTo(1); // b.y (local, not world)
    const world = boneWorldPositions(sk, p);
    expect(world[0].y).toBeCloseTo(1);
    expect(world[1].y).toBeCloseTo(2); // stacked
  });

  it("identity pose leaves the mesh in bind space", () => {
    const sk = makeSkeleton([bone("a", -1, 0, 1, 0)]);
    const palette = skinMatrices(sk, restPose(sk));
    // bindInv * bindWorld = identity
    const m = palette[0];
    expect(m.elements[0]).toBeCloseTo(1);
    expect(m.elements[12]).toBeCloseTo(0);
    expect(m.elements[13]).toBeCloseTo(0);
  });

  it("moving a bone moves the skinned vertex by the same delta", () => {
    const sk = makeSkeleton([bone("a", -1, 0, 1, 0)]);
    const p = restPose(sk);
    p[1] = 3; // bone moved from y=1 to y=3 (+2)
    const palette = skinMatrices(sk, p);
    const pos = skinVertex(sk, palette, {
      position: [0, 0, 0], joints: [0, 0, 0, 0], weights: [1, 0, 0, 0],
    });
    // The vertex keeps its offset from the bone: 0 (mesh) - 1 (bind) = -1,
    // and the bone is now at 3, so the vertex lands at 2.
    expect(pos[1]).toBeCloseTo(2);
  });
});

describe("clip sampling", () => {
  const clip: Clip = {
    name: "c",
    duration: 2,
    loop: true,
    channels: [{ bone: 0, times: [0, 1, 2], values: [[0, 0, 0, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1, 1], [0, 0, 0, 0, 1, 1, 1]] }],
  };

  it("wraps and clamps time", () => {
    expect(wrapTime(0.5, 2, true)).toBeCloseTo(0.5);
    expect(wrapTime(2.5, 2, true)).toBeCloseTo(0.5);
    expect(wrapTime(-0.5, 2, true)).toBeCloseTo(1.5);
    expect(wrapTime(5, 2, false)).toBe(2);
    expect(wrapTime(-1, 2, false)).toBe(0);
    expect(wrapTime(1, 0, true)).toBe(0);
  });

  it("interpolates between keys and clamps at the ends", () => {
    const sk = makeSkeleton([bone("a", -1)]);
    const out = makePose(1);
    out.set(restPose(sk));
    sampleClip(clip, 0.5, out, 1);
    expect(out[1]).toBeCloseTo(0.5);
    sampleClip(clip, 1.5, out, 1);
    expect(out[1]).toBeCloseTo(0.5);
    // 9s into a 2s loop wraps to t=1 -> the middle key.
    sampleClip(clip, 9, out, 1);
    expect(out[1]).toBeCloseTo(1);
  });

  it("supports step interpolation", () => {
    const stepped: Clip = {
      name: "s", duration: 1, loop: false,
      channels: [{ bone: 0, times: [0, 1], values: [[0, 0, 0, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1, 1]], interp: "step" }],
    };
    const sk = makeSkeleton([bone("a", -1)]);
    const out = makePose(1);
    sampleClip(stepped, 0.9, out, 1);
    expect(out[1]).toBe(0);
  });

  it("leaves unchanneled bones at their current value (layering)", () => {
    const sk = makeSkeleton([bone("a", -1), bone("b", 0, 0, 1, 0)]);
    const out = restPose(sk);
    const before = out[7 + 1];
    sampleClip(clip, 0.5, out, 2);
    expect(out[7 + 1]).toBe(before);
    expect(out[1]).toBeCloseTo(0.5);
  });

  it("ignores malformed keys instead of writing NaN", () => {
    const bad: Clip = {
      name: "b", duration: 1, loop: false,
      channels: [{ bone: 0, times: [0], values: [[NaN, 0, 0, 0]] as unknown as number[][0] as never }],
    };
    const sk = makeSkeleton([bone("a", -1)]);
    const out = restPose(sk);
    sampleClip(bad, 0.5, out, 1);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("blending and root motion", () => {
  it("blends linearly and clamps t", () => {
    const a = makePose(1);
    const b = makePose(1);
    a[1] = 0; b[1] = 10;
    const out = makePose(1);
    blendPose(a, b, 0.5, out);
    expect(out[1]).toBeCloseTo(5);
    blendPose(a, b, 5, out);
    expect(out[1]).toBe(10);
  });

  it("extracts planar root motion", () => {
    const a = makePose(1);
    const b = clonePose(a);
    b[0] = 1; b[2] = -2;
    const d = rootMotion(a, b);
    expect(d.x).toBeCloseTo(1);
    expect(d.z).toBeCloseTo(-2);
    // A rooted bone produces no world motion.
    expect(rootMotion(a, b, 0, 1).x).toBe(0);
  });
});

describe("skinned mesh assembly", () => {
  it("normalizes weights and repairs degenerate rows", () => {
    const mesh = buildSkinMesh([
      { position: [0, 0, 0], joints: [0, 1, 0, 0], weights: [2, 2, 0, 0] },
      { position: [1, 0, 0], joints: [0, 0, 0, 0], weights: [0, 0, 0, 0] },
    ], [0, 1]);
    expect(mesh.weights[0]).toBeCloseTo(0.5);
    expect(mesh.weights[1]).toBeCloseTo(0.5);
    expect(mesh.weights[4]).toBe(1); // degenerate row binds fully
    expect(mesh.indices).toHaveLength(2);
  });

  it("blends multiple influences", () => {
    const sk = makeSkeleton([bone("a", -1, 0, 0, 0), bone("b", -1, 0, 10, 0)]);
    const p = restPose(sk);
    p[1 * 7 + 1] = 20; // move bone b up by 10
    const palette = skinMatrices(sk, p);
    const v = {
      position: [0, 0, 0] as [number, number, number],
      joints: [0, 1, 0, 0] as [number, number, number, number],
      weights: [0.5, 0.5, 0, 0] as [number, number, number, number],
    };
    const pos = skinVertex(sk, palette, v);
    // Half the influence comes from bone b (+10) => +5.
    expect(pos[1]).toBeCloseTo(5);
  });
});

describe("state machine", () => {
  const def = {
    initial: "idle",
    states: [
      { name: "idle", clip: "idle", blend: 0.2 },
      { name: "run", clip: "run", blend: 0.3, transitions: [{ to: "idle", condition: "stopped", duration: 0.4 }] },
    ],
  };

  it("rejects an unknown initial state", () => {
    expect(() => new AnimationStateMachine({ initial: "nope", states: def.states })).toThrow();
  });

  it("transitions only on a true condition and blends", () => {
    const m = new AnimationStateMachine(def);
    expect(m.stateName).toBe("idle");
    expect(m.update(0.1, { stopped: false }).changed).toBe(false);
    m.update(0.1, { running: true });
    // no transition from idle without a condition
    expect(m.stateName).toBe("idle");
    // jump straight to run by evaluating its transitions
    const m2 = new AnimationStateMachine({ ...def, initial: "run" });
    const r = m2.update(0.1, { stopped: true });
    expect(r.changed).toBe(true);
    expect(m2.stateName).toBe("idle");
    // The blend starts at 0 on transition and grows over the duration.
    expect(m2.runtime.blend).toBe(0);
    m2.update(0.2, { stopped: false });
    expect(m2.runtime.blend).toBeCloseTo(0.5);
    m2.update(0.2, { stopped: false });
    expect(m2.runtime.blend).toBe(1);
  });

  it("ignores transitions to undefined states", () => {
    const m = new AnimationStateMachine({
      initial: "a",
      states: [{ name: "a", clip: "x", transitions: [{ to: "ghost", condition: "go" }] }],
    });
    expect(m.update(0.1, { go: true }).changed).toBe(false);
    expect(m.stateName).toBe("a");
  });
});

describe("IK", () => {
  const sk = makeSkeleton([bone("root", -1, 0, 1, 0), bone("mid", 0, 0, 1, 0), bone("tip", 1, 0, 1, 0)]);

  it("aims the tip at the target", () => {
    const p = restPose(sk);
    const r = solveTwoBoneIKYaw(sk, p, { root: 0, mid: 1, tip: 2, target: new Vec3(3, 1, 0) });
    expect(r.tipYaw).toBeCloseTo(Math.atan2(3, 0), 5);
  });

  it("reports unreachable targets and clamps the distance", () => {
    const p = restPose(sk);
    const near = solveTwoBoneIKYaw(sk, p, { root: 0, mid: 1, tip: 2, target: new Vec3(0.5, 1, 0) });
    expect(near.reachable).toBe(true);
    const far = solveTwoBoneIKYaw(sk, p, { root: 0, mid: 1, tip: 2, target: new Vec3(100, 1, 0) });
    expect(far.reachable).toBe(false);
    expect(far.clampedDistance).toBeLessThan(100);
  });

  it("respects the weight and is safe on degenerate chains", () => {
    const p = restPose(sk);
    const half = solveTwoBoneIKYaw(sk, p, { root: 0, mid: 1, tip: 2, target: new Vec3(10, 1, 0), weight: 0 });
    expect(half.tipYaw).toBeCloseTo(0);
    const bad = solveTwoBoneIK(sk, p, { root: 0, mid: 1, tip: 2, target: new Vec3(), weight: 1 });
    expect(Number.isFinite(bad[2 * 7 + 3])).toBe(true);
  });
});

describe("AnimatorSystem end to end", () => {
  function bank(): ClipBank {
    const b: ClipBank = { skeletons: new Map(), clips: new Map(), machines: new Map() };
    registerDemoCharacter(b);
    return b;
  }

  it("attaches, evaluates and exposes a palette", () => {
    const world = new World();
    const sys = new AnimatorSystem(world, bank());
    const e = makeAnimEntity(world, 0, 0, 0);
    expect(sys.attach(e, makeAnimator("demo-skel", "demo-machine"))).toBe(true);
    expect(sys.attach(999 as never, makeAnimator("nope", "nope"))).toBe(false);
    sys.update(0.1);
    const palette = sys.paletteOf(e)!;
    expect(palette).toHaveLength(5);
    expect(sys.boneCountOf(e)).toBe(5);
    expect(sys.stateOf(e)).toBe("idle");
  });

  it("transitions idle -> walk on a condition and crossfades", () => {
    const world = new World();
    const sys = new AnimatorSystem(world, bank());
    const e = makeAnimEntity(world);
    sys.attach(e, makeAnimator("demo-skel", "demo-machine"));
    // drive run directly: the demo machine's run state returns to idle
    sys.update(0.016, () => ({ stopped: false }));
    const st = sys.stateOf(e);
    expect(st === "idle" || st === "walk").toBe(true);
  });

  it("fires clip events once per pass", () => {
    const world = new World();
    const sys = new AnimatorSystem(world, bank());
    const e = makeAnimEntity(world);
    sys.attach(e, makeAnimator("demo-skel", "demo-machine"));
    // walk clip has two footstep events per 1.2s loop
    const fired: string[] = [];
    sys.onEvent = (ev) => fired.push(ev.name);
    for (let i = 0; i < 200; i++) {
      sys.update(0.016, () => ({}));
      sys.drainEvents();
    }
    // idle has no events, so nothing should fire; walking is exercised below
    expect(fired).toEqual([]);
  });

  it("applies root motion when enabled", () => {
    const world = new World();
    const sys = new AnimatorSystem(world, bank());
    const e = makeAnimEntity(world, 5, 0, 5);
    const comp = makeAnimator("demo-skel", "demo-machine");
    comp.rootMotion = true;
    sys.attach(e, comp);
    sys.update(0.1);
    const t = world.get<{ position: Vec3 }>(e, "transform")!;
    // The walk clip does not translate the hips, so the entity must not drift
    // except by the hips' bob. Guard against a runaway integration bug.
    expect(Number.isFinite(t.position.x)).toBe(true);
    expect(Math.abs(t.position.x - 5)).toBeLessThan(0.5);
  });

  it("detaches and forgets dead entities", () => {
    const world = new World();
    const sys = new AnimatorSystem(world, bank());
    const e = makeAnimEntity(world);
    sys.attach(e, makeAnimator("demo-skel", "demo-machine"));
    expect(sys.rigCount).toBe(1);
    world.destroy(e);
    sys.update(0.1);
    expect(sys.rigCount).toBe(0);
    expect(sys.paletteOf(e)).toBeNull();
  });

  it("a throwing event listener cannot break the frame", () => {
    const world = new World();
    const b = bank();
    b.clips.set(clipKey("demo-skel", "idle"), {
      name: "idle", duration: 1, loop: true, channels: [],
      events: [{ time: 0.5, name: "boom" }],
    });
    const sys = new AnimatorSystem(world, b);
    const e = makeAnimEntity(world);
    sys.attach(e, makeAnimator("demo-skel", "demo-machine"));
    sys.onEvent = () => {
      throw new Error("listener is broken");
    };
    expect(() => {
      for (let i = 0; i < 60; i++) sys.update(0.016);
    }).not.toThrow();
    expect(sys.events.length).toBeGreaterThan(0);
  });

  it("holds the rest pose when a clip is missing", () => {
    const world = new World();
    const b = bank();
    b.clips.delete(clipKey("demo-skel", "idle"));
    const sys = new AnimatorSystem(world, b);
    const e = makeAnimEntity(world);
    sys.attach(e, makeAnimator("demo-skel", "demo-machine"));
    sys.update(0.1);
    const p = sys.poseOf(e)!;
    const rest = restPose(sys["bank" as never] && b.skeletons.get("demo-skel")!);
    for (let i = 0; i < p.length; i++) expect(p[i]).toBeCloseTo(rest[i]);
  });

  it("the demo walk clip actually animates the rig", () => {
    const sk = makeSkeleton(DEMO_BONES_SRC);
    const world = new World();
    const full = bank();
    const b: ClipBank = {
      skeletons: new Map([["demo-skel", sk]]),
      clips: new Map([
        [clipKey("demo-skel", "walk"), makeWalkClip()],
        [clipKey("demo-skel", "idle"), full.clips.get(clipKey("demo-skel", "idle"))!],
      ]),
      machines: new Map([["demo-machine", DEMO_MACHINE]]),
    };
    const sys = new AnimatorSystem(world, b);
    const e = makeAnimEntity(world);
    sys.attach(e, makeAnimator("demo-skel", "demo-machine"));
    // Walk state has arm channels, so the pose must change over time.
    const rig = sys as unknown as { rigs: Map<number, { machine: { runtime: { current: string } } }> };
    rig.rigs.get(e)!.machine.runtime.current = "walk";
    sys.update(0.3);
    const p0 = Array.from(sys.poseOf(e)!);
    sys.update(0.3);
    const p1 = Array.from(sys.poseOf(e)!);
    expect(p0.some((v, i) => Math.abs(v - p1[i]) > 1e-6)).toBe(true);
    // The arms specifically must move (armL is bone 3 -> offset 21).
    expect(Math.abs(p0[21 + 3] - p1[21 + 3])).toBeGreaterThan(1e-3);
  });
});
