// Glitch demo character — a 5-bone skeleton with procedurally generated
// walk/idle/jump clips and a two-state machine. This is the "runner-visible
// proof" for the animation system: no external art, all original geometry
// (boxes weighted to bones).

import type { Bone, Clip, Skeleton, StateMachineDef } from "./skeleton.js";
import { makeSkeleton } from "./skeleton.js";
import { clipKey, type ClipBank } from "./animator.js";

// Bone layout: 0 hips (root), 1 torso, 2 head, 3 armL, 4 armR.
export const DEMO_BONES: Bone[] = [
  { name: "hips", parent: -1, bindPos: [0, 0.9, 0], bindRotY: 0, bindScale: [1, 1, 1] },
  { name: "torso", parent: 0, bindPos: [0, 0.35, 0], bindRotY: 0, bindScale: [1, 1, 1] },
  { name: "head", parent: 1, bindPos: [0, 0.4, 0], bindRotY: 0, bindScale: [1, 1, 1] },
  { name: "armL", parent: 1, bindPos: [0.28, 0.28, 0], bindRotY: 0, bindScale: [1, 1, 1] },
  { name: "armR", parent: 1, bindPos: [-0.28, 0.28, 0], bindRotY: 0, bindScale: [1, 1, 1] },
];

const HIP = 0, TORSO = 1, HEAD = 2, ARM_L = 3, ARM_R = 4;

function key(t: number, x: number, y: number, z: number, ry: number, s = 1): number[] {
  return [x, y, z, ry, s, s, s];
}

/** Values for a frame of the walk cycle at phase p (0..1). */
function walkFrame(p: number): number[][] {
  const s = Math.sin(p * Math.PI * 2);
  const c = Math.cos(p * Math.PI * 2);
  return [
    key(0, 0, 0.9 + Math.abs(s) * 0.05, 0, 0),          // hips bob
    key(0, 0, 0.35, 0, s * 0.12),                       // torso twist
    key(0, 0, 0.4, 0, -s * 0.08),                        // head counter
    key(0, 0.28, 0.28, 0, -s * 0.9),                     // armL
    key(0, -0.28, 0.28, 0, s * 0.9),                     // armR
  ];
}

export function makeWalkClip(steps = 4, secondsPerStep = 0.3): Clip {
  const channels = [HIP, TORSO, HEAD, ARM_L, ARM_R].map((bone) => {
    const times: number[] = [];
    const values: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      times.push(i * secondsPerStep);
      values.push(walkFrame(i / steps)[bone]);
    }
    return { bone, times, values };
  });
  return {
    name: "walk",
    duration: steps * secondsPerStep,
    loop: true,
    channels,
    events: [{ time: 0, name: "footstep", payload: { foot: "L" } }, { time: secondsPerStep * 2, name: "footstep", payload: { foot: "R" } }],
  };
}

export function makeIdleClip(): Clip {
  const t0 = 0, t1 = 2;
  return {
    name: "idle",
    duration: 2,
    loop: true,
    channels: [
      { bone: HIP, times: [t0, t1], values: [key(0, 0, 0.9, 0, 0), key(0, 0, 0.94, 0, 0)] },
      { bone: TORSO, times: [t0, t1], values: [key(0, 0, 0.35, 0, 0.02), key(0, 0, 0.35, 0, -0.02)] },
      { bone: ARM_L, times: [t0, t1], values: [key(0, 0.28, 0.28, 0, 0.05), key(0, 0.28, 0.28, 0, -0.05)] },
      { bone: ARM_R, times: [t0, t1], values: [key(0, -0.28, 0.28, 0, -0.05), key(0, -0.28, 0.28, 0, 0.05)] },
    ],
  };
}

export const DEMO_MACHINE: StateMachineDef = {
  initial: "idle",
  states: [
    { name: "idle", clip: "idle", speed: 1, loop: true, blend: 0.25 },
    {
      name: "walk", clip: "walk", speed: 1, loop: true, blend: 0.2,
      transitions: [{ to: "idle", condition: "stopped", duration: 0.2 }],
    },
  ],
};

/** Registers the demo rig into a clip bank. */
export function registerDemoCharacter(bank: ClipBank, skeletonId = "demo-skel", machineId = "demo-machine"): Skeleton {
  const sk = makeSkeleton(DEMO_BONES);
  bank.skeletons.set(skeletonId, sk);
  bank.clips.set(clipKey(skeletonId, "walk"), makeWalkClip());
  bank.clips.set(clipKey(skeletonId, "idle"), makeIdleClip());
  bank.machines.set(machineId, DEMO_MACHINE);
  return sk;
}
