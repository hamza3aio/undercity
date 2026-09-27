// Glitch skeletal animation — skeleton, clips, skinning, blending, state
// machines, events, root motion and a two-bone IK foundation.
//
// Design: the math is pure (bindings, matrices, pose evaluation, sampling,
// blending, state transitions) so all of it is headless-testable. The GPU
// path is a single skinning vertex stage in shader.ts (SKINNED_VERT_SRC)
// driven by a bone matrix palette uploaded per entity, plus a fragment
// stage identical to the legacy lit path, so a skinned mesh looks exactly
// like a static one.
//
// Not implemented (documented, not faked): humanoid retargeting, animation
// blending trees beyond 1-D clip crossfade, cloth/hair simulation.

import { Vec3 } from "../math/vec3.js";
import { Mat4 } from "../math/mat4.js";

export interface Bone {
  name: string;
  parent: number; // index, or -1 for a root
  /** Bind-pose local transform, relative to the parent. */
  bindPos: [number, number, number];
  bindRotY: number;
  bindScale: [number, number, number];
}

export interface Skeleton {
  bones: Bone[];
  /** Cached bind-pose inverse matrices, one per bone. */
  bindInv: Mat4[];
}

/** Bind-pose skeleton from a bone list (order does not matter). */
export function makeSkeleton(bones: Bone[]): Skeleton {
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    if (b.parent >= bones.length) throw new Error(`makeSkeleton: bone ${i} parent out of range`);
    if (b.parent === i) throw new Error("makeSkeleton: bone cannot parent itself");
  }
  return { bones, bindInv: computeBindInverse(bones) };
}

// World bind matrix of a bone (parent chain), then inverted.
export function bindWorld(bones: Bone[], i: number, memo?: Mat4[]): Mat4 {
  if (memo && memo[i]) return memo[i];
  const b = bones[i];
  const local = Mat4.compose(new Vec3(...b.bindPos), b.bindRotY, new Vec3(...b.bindScale));
  const out = b.parent < 0 ? local : local.multiply(bindWorld(bones, b.parent, memo));
  if (memo) memo[i] = out;
  return out;
}

function computeBindInverse(bones: Bone[]): Mat4[] {
  const memo: Mat4[] = [];
  const out: Mat4[] = [];
  for (let i = 0; i < bones.length; i++) {
    const inv = bindWorld(bones, i, memo).invert();
    if (!inv) throw new Error(`makeSkeleton: bone ${i} bind matrix is singular`);
    out.push(inv);
  }
  return out;
}

export interface ClipChannel {
  bone: number;
  /** Keyframe times in seconds, strictly increasing. */
  times: number[];
  /** One entry per key: [x, y, z, rotY, sx, sy, sz] */
  values: number[][];
  /** Interpolation for this channel. Default linear. */
  interp?: "linear" | "step";
}

export interface ClipEvent {
  time: number;
  name: string;
  payload?: unknown;
}

export interface Clip {
  name: string;
  duration: number;
  channels: ClipChannel[];
  events?: ClipEvent[];
  loop?: boolean;
}

/** Normalized pose: one local TRS per bone. */
export type Pose = Float32Array; // bones * 7 -> [x, y, z, rotY, sx, sy, sz]

export function makePose(boneCount: number): Pose {
  const p = new Float32Array(boneCount * 7);
  for (let i = 0; i < boneCount; i++) {
    const o = i * 7;
    p[o] = 0; p[o + 1] = 0; p[o + 2] = 0; p[o + 3] = 0;
    p[o + 4] = 1; p[o + 5] = 1; p[o + 6] = 1;
  }
  return p;
}

export function clonePose(p: Pose): Pose {
  return p.slice() as Pose;
}

/** Rest pose from the skeleton's bind transforms. */
export function restPose(sk: Skeleton): Pose {
  const p = makePose(sk.bones.length);
  for (let i = 0; i < sk.bones.length; i++) {
    const b = sk.bones[i];
    const o = i * 7;
    p[o] = b.bindPos[0]; p[o + 1] = b.bindPos[1]; p[o + 2] = b.bindPos[2];
    p[o + 3] = b.bindRotY;
    p[o + 4] = b.bindScale[0]; p[o + 5] = b.bindScale[1]; p[o + 6] = b.bindScale[2];
  }
  return p;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

function sampleChannel(c: ClipChannel, time: number, out: Float32Array, boneCount: number): void {
  const o = boneCount > 0 ? c.bone * 7 : 0;
  const n = c.times.length;
  if (n === 0) return;
  if (time <= c.times[0]) {
    writeValues(c.values[0], out, o);
    return;
  }
  if (time >= c.times[n - 1]) {
    writeValues(c.values[n - 1], out, o);
    return;
  }
  let i = 0;
  while (i < n - 2 && c.times[i + 1] < time) i++;
  const t0 = c.times[i], t1 = c.times[i + 1];
  const span = t1 - t0;
  if (c.interp === "step" || span <= 1e-9) {
    writeValues(c.values[i], out, o);
    return;
  }
  const t = (time - t0) / span;
  const a = c.values[i], b = c.values[i + 1];
  for (let k = 0; k < 7; k++) {
    out[o + k] = lerp(a[k] ?? 0, b[k] ?? 0, t);
  }
}

function writeValues(v: number[], out: Float32Array, o: number): void {
  for (let k = 0; k < 7; k++) {
    const val = v[k];
    if (typeof val === "number" && Number.isFinite(val)) out[o + k] = val;
  }
}

/**
 * Samples a clip into a pose. Bones without a channel keep their current
 * value, so layering a partial clip over a full pose works.
 */
export function sampleClip(clip: Clip, time: number, out: Pose, boneCount: number): void {
  const t = wrapTime(time, clip.duration, clip.loop !== false);
  for (const c of clip.channels) sampleChannel(c, t, out, boneCount);
}

/** Clamps or wraps time into the clip. */
export function wrapTime(time: number, duration: number, loop: boolean): number {
  if (!(duration > 0)) return 0;
  if (loop) {
    const t = time % duration;
    return t < 0 ? t + duration : t;
  }
  return Math.max(0, Math.min(duration, time));
}

export function blendPose(a: Pose, b: Pose, t: number, out: Pose): Pose {
  const k = Math.max(0, Math.min(1, t));
  for (let i = 0; i < a.length; i++) out[i] = lerp(a[i], b[i], k);
  return out;
}

// --- skinning ---

export interface IKChain {
  root: number; // bone index
  mid: number; // child of root
  tip: number; // child of mid
  target: Vec3;
  /** How hard to pull: 0 = leave, 1 = full. */
  weight?: number;
  poleTarget?: Vec3;
}

export interface SkinVertex {  position: [number, number, number];
  /** Bone influences (index, weight), 1-4 per vertex, weights normalized. */
  joints: [number, number, number, number];
  weights: [number, number, number, number];
  normal?: [number, number, number];
  uv?: [number, number];
}

export interface SkinMesh {
  positions: Float32Array; // 3 per vertex
  joints: Float32Array; // 4 per vertex (bone indices as floats)
  weights: Float32Array; // 4 per vertex
  normals: Float32Array; // 3 per vertex
  uvs: Float32Array; // 2 per vertex
  indices: Uint16Array;
}

/** Assembles a skinned mesh from vertices, normalizing weights. */
export function buildSkinMesh(verts: SkinVertex[], indices: number[]): SkinMesh {
  const n = verts.length;
  const out: SkinMesh = {
    positions: new Float32Array(n * 3),
    joints: new Float32Array(n * 4),
    weights: new Float32Array(n * 4),
    normals: new Float32Array(n * 3),
    uvs: new Float32Array(n * 2),
    indices: new Uint16Array(indices),
  };
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    out.positions[i * 3] = v.position[0];
    out.positions[i * 3 + 1] = v.position[1];
    out.positions[i * 3 + 2] = v.position[2];
    out.normals[i * 3] = v.normal?.[0] ?? 0;
    out.normals[i * 3 + 1] = v.normal?.[1] ?? 1;
    out.normals[i * 3 + 2] = v.normal?.[2] ?? 0;
    out.uvs[i * 2] = v.uv?.[0] ?? 0;
    out.uvs[i * 2 + 1] = v.uv?.[1] ?? 0;
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += Math.max(0, v.weights[k] ?? 0);
    if (sum <= 1e-8) {
      // Degenerate influence: bind fully to the first joint rather than NaN.
      out.weights[i * 4] = 1;
    } else {
      for (let k = 0; k < 4; k++) {
        out.joints[i * 4 + k] = v.joints[k] ?? 0;
        out.weights[i * 4 + k] = Math.max(0, v.weights[k] ?? 0) / sum;
      }
    }
  }
  return out;
}

/** Skinning matrices: bindInv[bone] * animatedWorld[bone]. */
export function skinMatrices(sk: Skeleton, pose: Pose, out?: Mat4[]): Mat4[] {
  const n = sk.bones.length;
  const world: Mat4[] = new Array(n);
  const palette: Mat4[] = out && out.length === n ? out : new Array(n);
  for (let i = 0; i < n; i++) {
    const b = sk.bones[i];
    const o = i * 7;
    const local = Mat4.compose(
      new Vec3(pose[o], pose[o + 1], pose[o + 2]),
      pose[o + 3],
      new Vec3(pose[o + 4], pose[o + 5], pose[o + 6])
    );
    world[i] = b.parent < 0 ? local : local.multiply(world[b.parent]);
    palette[i] = sk.bindInv[i].multiply(world[i]);
  }
  return palette;
}

/** World-space bone positions for a pose (used by IK, gizmos, attachment). */
export function boneWorldPositions(sk: Skeleton, pose: Pose, out?: Vec3[]): Vec3[] {
  const n = sk.bones.length;
  const world: Mat4[] = new Array(n);
  const result: Vec3[] = out && out.length === n ? out : new Array(n);
  for (let i = 0; i < n; i++) {
    const b = sk.bones[i];
    const o = i * 7;
    const local = Mat4.compose(
      new Vec3(pose[o], pose[o + 1], pose[o + 2]),
      pose[o + 3],
      new Vec3(pose[o + 4], pose[o + 5], pose[o + 6])
    );
    world[i] = b.parent < 0 ? local : local.multiply(world[b.parent]);
    result[i] = result[i] ?? new Vec3();
    result[i].set(world[i].elements[12], world[i].elements[13], world[i].elements[14]);
  }
  return result;
}

/** CPU-skinned position of one vertex (tests, hit queries, attachment). */
export function skinVertex(
  sk: Skeleton, palette: Mat4[], v: SkinVertex
): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 4; k++) {
    const w = v.weights[k] ?? 0;
    if (w <= 0) continue;
    const m = palette[v.joints[k] ?? 0];
    const px = v.position[0], py = v.position[1], pz = v.position[2];
    x += w * (m.elements[0] * px + m.elements[4] * py + m.elements[8] * pz + m.elements[12]);
    y += w * (m.elements[1] * px + m.elements[5] * py + m.elements[9] * pz + m.elements[13]);
    z += w * (m.elements[2] * px + m.elements[6] * py + m.elements[10] * pz + m.elements[14]);
  }
  return [x, y, z];
}

/**
 * Two-bone IK in the yaw-only bone convention: aims the tip bone at the
 * target and clamps the reach. Returns the tip bone's new yaw (the caller
 * writes it into the pose, so this is pure and testable).
 */
export function solveTwoBoneIKYaw(
  sk: Skeleton, pose: Pose, chain: IKChain
): { tipYaw: number; reachable: boolean; clampedDistance: number } {
  const weight = chain.weight ?? 1;
  const pos = boneWorldPositions(sk, pose);
  const rootPos = pos[chain.root], midPos = pos[chain.mid], tipPos = pos[chain.tip];
  if (!rootPos || !midPos || !tipPos) {
    return { tipYaw: pose[chain.tip * 7 + 3], reachable: false, clampedDistance: 0 };
  }
  const l1 = Math.hypot(midPos.x - rootPos.x, midPos.y - rootPos.y, midPos.z - rootPos.z);
  const l2 = Math.hypot(tipPos.x - midPos.x, tipPos.y - midPos.y, tipPos.z - midPos.z);
  if (l1 < 1e-6 || l2 < 1e-6 || weight <= 0) {
    return { tipYaw: pose[chain.tip * 7 + 3], reachable: false, clampedDistance: 0 };
  }
  const reach = l1 + l2;
  const wanted = Math.hypot(chain.target.x - rootPos.x, chain.target.y - rootPos.y, chain.target.z - rootPos.z);
  const clamped = Math.min(wanted, reach);
  const dirX = chain.target.x - rootPos.x;
  const dirZ = chain.target.z - rootPos.z;
  const currentYaw = pose[chain.tip * 7 + 3];
  const wantYaw = Math.atan2(dirX, dirZ);
  const blended = currentYaw + wrapAngle(wantYaw - currentYaw) * Math.max(0, Math.min(1, weight));
  return { tipYaw: blended, reachable: wanted <= reach, clampedDistance: clamped };
}

/** Two-bone IK: writes the solved tip yaw back into the pose. */
export function solveTwoBoneIK(sk: Skeleton, pose: Pose, chain: IKChain): Pose {
  const r = solveTwoBoneIKYaw(sk, pose, chain);
  pose[chain.tip * 7 + 3] = r.tipYaw;
  return pose;
}

// --- state machine ---

export interface StateDef {
  name: string;
  clip: string;
  speed?: number;
  loop?: boolean;
  /** Blend time in seconds when entering this state. */
  blend?: number;
  /** Transitions evaluated while this state is active. */
  transitions?: { to: string; condition: string; duration?: number }[];
}

export interface StateMachineDef {
  states: StateDef[];
  initial: string;
}

export interface RuntimeState {
  current: string;
  previous: string;
  time: number;
  blend: number; // 0..1 progress of the current blend
  blendDuration: number;
}

export class AnimationStateMachine {
  private states = new Map<string, StateDef>();
  readonly machineId: string;
  private def: StateMachineDef;
  runtime: RuntimeState;

  constructor(def: StateMachineDef, machineId = "default") {
    this.def = def;
    this.machineId = machineId;
    for (const s of def.states) this.states.set(s.name, s);
    if (!this.states.has(def.initial)) throw new Error("AnimationStateMachine: unknown initial state");
    this.runtime = { current: def.initial, previous: def.initial, time: 0, blend: 1, blendDuration: 0 };
  }

  get stateName(): string {
    return this.runtime.current;
  }

  update(dt: number, conditions: Record<string, boolean> = {}): { changed: boolean; from: string | null } {
    const st = this.states.get(this.runtime.current);
    this.runtime.time += dt;
    if (this.runtime.blend < 1 && this.runtime.blendDuration > 0) {
      this.runtime.blend = Math.min(1, this.runtime.blend + dt / this.runtime.blendDuration);
    }
    if (!st?.transitions) return { changed: false, from: null };
    for (const t of st.transitions) {
      if (!conditions[t.condition]) continue;
      if (!this.states.has(t.to)) continue;
      const from = this.runtime.current;
      this.runtime.previous = from;
      this.runtime.current = t.to;
      this.runtime.time = 0;
      this.runtime.blend = 0;
      this.runtime.blendDuration = t.duration ?? this.states.get(t.to)?.blend ?? 0.2;
      return { changed: true, from };
    }
    return { changed: false, from: null };
  }

  currentState(): StateDef | undefined {
    return this.states.get(this.runtime.current);
  }

  /** State definitions in declaration order. */
  defs(): StateDef[] {
    return this.def.states;
  }

  /** Clip time for the active state, honouring speed. */
  clipTime(clips: Map<string, Clip>): number {
    const st = this.currentState();
    if (!st) return 0;
    const clip = clips.get(st.clip);
    if (!clip) return 0;
    return this.runtime.time * (st.speed ?? 1);
  }
}

// --- root motion ---

/** Extracts the planar delta of a root bone between two poses. */
export function rootMotion(a: Pose, b: Pose, rootBone = 0, rootParent = -1): Vec3 {
  if (rootParent >= 0) return new Vec3(); // rooted to a parent: no world motion
  const o = rootBone * 7;
  return new Vec3(b[o] - a[o], b[o + 1] - a[o + 1], b[o + 2] - a[o + 2]);
}
