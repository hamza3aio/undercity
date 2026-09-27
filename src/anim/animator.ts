// Glitch animator — runtime that drives skeletons from clips + a state
// machine, dispatches animation events and applies root motion. Pure logic
// (no GL/DOM): the renderer reads the resulting bone palette.

import { World, type Entity } from "../ecs/world.js";
import { Vec3 } from "../math/vec3.js";
import { makeTransform, type Transform } from "../ecs/components.js";
import {
  AnimationStateMachine, blendPose, boneWorldPositions, clonePose, makePose, restPose,
  sampleClip, skinMatrices, wrapTime,
  type Clip, type Pose, type Skeleton, type StateMachineDef,
} from "./skeleton.js";
import { Mat4 } from "../math/mat4.js";

export const ANIMATOR_COMPONENT = "animator";

export interface AnimatorComponent {
  skeletonId: string;
  machineId: string;
  speed: number;
  /** Apply the root bone's planar delta to the entity transform. */
  rootMotion: boolean;
}

export function makeAnimator(skeletonId: string, machineId: string): AnimatorComponent {
  return { skeletonId, machineId, speed: 1, rootMotion: false };
}

export function clipKey(skeletonId: string, clipName: string): string {
  return `${skeletonId}/${clipName}`;
}

export interface ClipBank {
  skeletons: Map<string, Skeleton>;
  clips: Map<string, Clip>; // keyed by clipKey(skeletonId, clipName)
  machines: Map<string, StateMachineDef>;
}

interface Rig {
  skeletonId: string;
  sk: Skeleton;
  machine: AnimationStateMachine;
  rest: Pose;
  pose: Pose;
  palette: Mat4[];
  fired: Set<string>;
}

export interface AnimEvent {
  entity: Entity;
  name: string;
  payload?: unknown;
  time: number;
}

export class AnimatorSystem {
  private rigs = new Map<Entity, Rig>();
  /** Events emitted this frame; drain with drainEvents(). */
  events: AnimEvent[] = [];
  onEvent: ((e: AnimEvent) => void) | null = null;

  constructor(private world: World, private bank: ClipBank) {}

  get rigCount(): number {
    return this.rigs.size;
  }

  attach(e: Entity, comp: AnimatorComponent): boolean {
    const sk = this.bank.skeletons.get(comp.skeletonId);
    const def = this.bank.machines.get(comp.machineId);
    if (!sk || !def || !this.world.isAlive(e)) return false;
    this.detach(e);
    const n = sk.bones.length;
    this.rigs.set(e, {
      skeletonId: comp.skeletonId,
      sk,
      machine: new AnimationStateMachine(def, comp.machineId),
      rest: restPose(sk),
      pose: makePose(n),
      palette: Array.from({ length: n }, () => new Mat4()),
      fired: new Set<string>(),
    });
    this.world.add(e, ANIMATOR_COMPONENT, comp);
    return true;
  }

  detach(e: Entity): void {
    this.rigs.delete(e);
    this.world.remove(e, ANIMATOR_COMPONENT);
  }

  stateOf(e: Entity): string | null {
    return this.rigs.get(e)?.machine.stateName ?? null;
  }

  /** Advances every attached rig. Returns how many were updated. */
  update(dt: number, conditions: (e: Entity, state: string) => Record<string, boolean> = () => ({})): number {
    let n = 0;
    for (const [e, rig] of this.rigs) {
      if (!this.world.isAlive(e)) {
        this.rigs.delete(e);
        continue;
      }
      const comp = this.world.get<AnimatorComponent>(e, ANIMATOR_COMPONENT);
      const step = dt * (comp?.speed ?? 1);
      const changed = rig.machine.update(step, conditions(e, rig.machine.stateName));
      if (changed.changed) rig.fired.clear();
      this.evaluate(e, rig, step, comp);
      n++;
    }
    return n;
  }

  private evaluate(e: Entity, rig: Rig, step: number, comp?: AnimatorComponent): void {
    const st = rig.machine.currentState();
    if (!st) return;
    const clip = this.bank.clips.get(clipKey(rig.skeletonId, st.clip));
    const time = rig.machine.runtime.time * (st.speed ?? 1);
    const n = rig.sk.bones.length;

    if (!clip) {
      // No clip for this state: hold the rest pose rather than freezing garbage.
      rig.pose.set(rig.rest);
      skinMatrices(rig.sk, rig.pose, rig.palette);
      return;
    }

    const before = clonePose(rig.pose);
    const next = makePose(n);
    next.set(rig.rest);
    sampleClip(clip, time, next, n);

    const blend = rig.machine.runtime.blend;
    if (blend < 1) {
      const prevName = rig.machine.runtime.previous;
      const prevDef = prevName === rig.machine.stateName
        ? undefined
        : rig.machine.defs().find((s) => s.name === prevName);
      const prevClip = prevDef ? this.bank.clips.get(clipKey(rig.skeletonId, prevDef.clip)) : undefined;
      if (prevClip) {
        const from = makePose(n);
        from.set(rig.rest);
        sampleClip(prevClip, rig.machine.runtime.time * (prevDef?.speed ?? 1), from, n);
        blendPose(from, next, blend, rig.pose);
      } else {
        rig.pose.set(next);
      }
    } else {
      rig.pose.set(next);
    }
    skinMatrices(rig.sk, rig.pose, rig.palette);

    this.fireEvents(e, rig, clip, time, step);
    this.applyRootMotion(e, rig, before, comp);
  }

  private fireEvents(e: Entity, rig: Rig, clip: Clip, time: number, step: number): void {
    if (!clip.events || clip.events.length === 0) return;
    const loop = clip.loop !== false;
    const dur = clip.duration > 0 ? clip.duration : 1;
    const prevT = wrapTime(time - step, dur, loop);
    const curT = wrapTime(time, dur, loop);
    const wrapped = loop && curT < prevT;
    // An event fires when this frame's [prevT, curT] window covers it. On a
    // looping clip a wrapping frame splits the window into two segments.
    const within = (t: number): boolean =>
      loop && wrapped ? t >= prevT || t <= curT : t > prevT && t <= curT;
    for (const ev of clip.events) {
      if (!within(ev.time)) continue;
      // Once per pass, keyed so a paused/re-entered state does not re-fire.
      const k = `${rig.machine.stateName}:${ev.name}:${ev.time.toFixed(4)}`;
      if (rig.fired.has(k)) continue;
      rig.fired.add(k);
      const rec: AnimEvent = { entity: e, name: ev.name, payload: ev.payload, time: ev.time };
      this.events.push(rec);
      if (this.onEvent) {
        try {
          this.onEvent(rec);
        } catch {
          // A throwing listener must not break the frame.
        }
      }
    }
  }

  private applyRootMotion(e: Entity, rig: Rig, before: Pose, comp?: AnimatorComponent): void {
    if (!comp?.rootMotion) return;
    const t = this.world.get<Transform>(e, "transform");
    if (!t) return;
    t.position.x += (rig.pose[0] - before[0]) * (comp.speed ?? 1);
    t.position.z += (rig.pose[2] - before[2]) * (comp.speed ?? 1);
  }

  /** Bone palette for the renderer (reused buffer; treat as read-only). */
  paletteOf(e: Entity): Mat4[] | null {
    return this.rigs.get(e)?.palette ?? null;
  }

  poseOf(e: Entity): Pose | null {
    return this.rigs.get(e)?.pose ?? null;
  }

  worldPositionsOf(e: Entity): Vec3[] | null {
    const rig = this.rigs.get(e);
    if (!rig) return null;
    return boneWorldPositions(rig.sk, rig.pose);
  }

  boneCountOf(e: Entity): number {
    return this.rigs.get(e)?.sk.bones.length ?? 0;
  }

  drainEvents(): AnimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/** Spawns an entity with a transform ready to receive an Animator. */
export function makeAnimEntity(world: World, x = 0, y = 0, z = 0): Entity {
  const e = world.create();
  world.add(e, "transform", makeTransform(x, y, z));
  return e;
}
