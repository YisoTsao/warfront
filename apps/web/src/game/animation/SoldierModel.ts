import type { Locomotion, Stance } from '@frontline/shared';
import * as THREE from 'three';
import { RiggedSoldier, soldierAssetReady } from './RiggedSoldier';

export type SoldierAnimation = 'idle' | 'walk' | 'run' | 'crouchIdle' | 'crouchWalk' | 'prone' | 'crawl' | 'airborne' | 'downed' | 'death';

const TEAM_COLORS = {
  alpha: { uniform: 0x4a5a3c, accent: 0x3a6ab8 },
  bravo: { uniform: 0x6a5a40, accent: 0xb84a30 },
  neutral: { uniform: 0x5a5a5a, accent: 0xc0c0c0 },
} as const;

export type SoldierTeam = keyof typeof TEAM_COLORS;

/** 士兵外觀的共同介面：骨架模型（RiggedSoldier）與程序產生的暫代模型都實作它。 */
export interface SoldierView {
  readonly root: THREE.Group;
  readonly muzzle: THREE.Object3D;
  readonly animation: SoldierAnimation | null;
  play(animation: SoldierAnimation, fade?: number): void;
  setSpotted(spotted: boolean): void;
  update(frameSeconds: number, pitch: number): void;
  dispose(): void;
}

const q = (x: number, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).toArray();

/** 由多個關鍵影格（Euler）建立四元數軌道。 */
function rotationTrack(bone: string, times: number[], eulers: Array<[number, number?, number?]>): THREE.QuaternionKeyframeTrack {
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, eulers.flatMap(([x, y, z]) => q(x, y ?? 0, z ?? 0)));
}

function positionTrack(bone: string, times: number[], values: Array<[number, number, number]>): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(`${bone}.position`, times, values.flat());
}

/** 手臂持槍姿勢（所有動作共用） */
function armTracks(times: number[]): THREE.KeyframeTrack[] {
  const hold = times.map(() => [-1.25, 0.3, 0] as [number, number, number]);
  const holdR = times.map(() => [-1.35, -0.2, 0] as [number, number, number]);
  return [
    rotationTrack('lUpperArm', times, hold),
    rotationTrack('lForearm', times, times.map(() => [-0.6, 0, 0])),
    rotationTrack('rUpperArm', times, holdR),
    rotationTrack('rForearm', times, times.map(() => [-0.9, 0, 0])),
  ];
}

function legCycle(duration: number, swing: number, knee: number, hipsY: number, bounce: number, lean: number, crouch = 0): THREE.AnimationClip {
  const t = [0, duration / 4, duration / 2, (3 * duration) / 4, duration];
  const thigh = (phase: number) => t.map((_, i) => [-crouch + Math.sin(((i / 4) * 2 + phase) * Math.PI) * swing] as [number]);
  const shin = (phase: number) => t.map((_, i) => [crouch * 1.2 + Math.max(0, Math.sin(((i / 4) * 2 + phase + 0.5) * Math.PI)) * knee] as [number]);
  return new THREE.AnimationClip('cycle', duration, [
    positionTrack('hips', t, t.map((_, i) => [0, hipsY + Math.abs(Math.cos((i / 4) * 2 * Math.PI)) * bounce, 0])),
    rotationTrack('hips', t, t.map(() => [0])),
    rotationTrack('spine', t, t.map(() => [lean])),
    rotationTrack('lThigh', t, thigh(0)),
    rotationTrack('rThigh', t, thigh(1)),
    rotationTrack('lShin', t, shin(0)),
    rotationTrack('rShin', t, shin(1)),
    ...armTracks(t),
  ]);
}

function pose(name: string, hipsY: number, hips: [number, number?, number?], spine: number, thigh: number, shin: number, duration = 1): THREE.AnimationClip {
  const t = [0, duration];
  return new THREE.AnimationClip(name, duration, [
    positionTrack('hips', t, [[0, hipsY, 0], [0, hipsY + 0.01, 0]]),
    rotationTrack('hips', t, [hips, hips]),
    rotationTrack('spine', t, [[spine], [spine]]),
    rotationTrack('lThigh', t, [[thigh, 0, 0.05], [thigh, 0, 0.05]]),
    rotationTrack('rThigh', t, [[thigh * 0.9, 0, -0.05], [thigh * 0.9, 0, -0.05]]),
    rotationTrack('lShin', t, [[shin], [shin]]),
    rotationTrack('rShin', t, [[shin], [shin]]),
    ...armTracks(t),
  ]);
}

/** 所有士兵共用同一組動畫片段（片段只描述骨架名稱，與實例無關）。 */
const CLIPS: Record<SoldierAnimation, THREE.AnimationClip> = {
  idle: pose('idle', 0.95, [0], 0.02, 0, 0, 2),
  walk: Object.assign(legCycle(0.95, 0.45, 0.7, 0.93, 0.03, 0.06), { name: 'walk' }),
  run: Object.assign(legCycle(0.62, 0.8, 1.2, 0.9, 0.06, 0.22), { name: 'run' }),
  crouchIdle: pose('crouchIdle', 0.56, [0.1], 0.25, -1.45, 1.75),
  crouchWalk: Object.assign(legCycle(1.1, 0.35, 0.6, 0.6, 0.02, 0.3, 1.2), { name: 'crouchWalk' }),
  prone: pose('prone', 0.2, [-1.5], 0, 0, 0.1),
  crawl: (() => {
    const t = [0, 0.6, 1.2];
    return new THREE.AnimationClip('crawl', 1.2, [
      positionTrack('hips', t, [[0, 0.2, 0], [0, 0.22, 0], [0, 0.2, 0]]),
      rotationTrack('hips', t, [[-1.5], [-1.5], [-1.5]]),
      rotationTrack('spine', t, [[0], [0], [0]]),
      rotationTrack('lThigh', t, [[0, 0, 0.3], [-0.6, 0, 0.3], [0, 0, 0.3]]),
      rotationTrack('rThigh', t, [[-0.6, 0, -0.3], [0, 0, -0.3], [-0.6, 0, -0.3]]),
      rotationTrack('lShin', t, [[0.4], [0.9], [0.4]]),
      rotationTrack('rShin', t, [[0.9], [0.4], [0.9]]),
      ...armTracks(t),
    ]);
  })(),
  airborne: pose('airborne', 0.98, [0], 0.05, -0.5, 0.9),
  downed: pose('downed', 0.25, [1.35, 0, 0.2], -0.2, -0.3, 0.6),
  death: (() => {
    const t = [0, 0.35, 0.7];
    return new THREE.AnimationClip('death', 0.7, [
      positionTrack('hips', t, [[0, 0.95, 0], [0, 0.55, 0.2], [0, 0.18, 0.4]]),
      rotationTrack('hips', t, [[0], [0.7, 0, 0.15], [1.5, 0, 0.3]]),
      rotationTrack('spine', t, [[0], [0.3], [0.1]]),
      rotationTrack('lThigh', t, [[0], [-0.6], [-0.2]]),
      rotationTrack('rThigh', t, [[0], [-0.3], [0.1]]),
      rotationTrack('lShin', t, [[0], [1], [0.3]]),
      rotationTrack('rShin', t, [[0], [0.5], [0.2]]),
      rotationTrack('lUpperArm', t, [[-1.25, 0.3, 0], [-2, 0.6, 0], [-2.6, 0.9, 0]]),
      rotationTrack('rUpperArm', t, [[-1.35, -0.2, 0], [-1.8, -0.8, 0], [-2.4, -1, 0]]),
    ]);
  })(),
};

/** 依姿勢、移動狀態與生死決定要播放的動畫。 */
export function animationFor(stance: Stance, locomotion: Locomotion, life: 'alive' | 'downed' | 'dead'): SoldierAnimation {
  if (life === 'dead') {
    return 'death';
  }
  if (life === 'downed') {
    return 'downed';
  }
  if (locomotion === 'airborne') {
    return 'airborne';
  }
  const moving = locomotion !== 'idle';
  if (stance === 'prone') {
    return moving ? 'crawl' : 'prone';
  }
  if (stance === 'crouching') {
    return moving ? 'crouchWalk' : 'crouchIdle';
  }
  return locomotion === 'sprinting' ? 'run' : moving ? 'walk' : 'idle';
}

/**
 * 士兵模型：士兵 glTF 已載入（preloadSoldierAsset）時用骨架模型，否則用程序產生的暫代模型。
 * 兩者介面相同，呼叫端不需要知道是哪一種。
 */
export class SoldierModel implements SoldierView {
  private readonly view: SoldierView;

  constructor(team: SoldierTeam | null, name = 'soldier') {
    this.view = soldierAssetReady() ? new RiggedSoldier(team ?? 'neutral', name) : new ProceduralSoldier(team, name);
  }

  /** 是否使用骨架模型（除錯與測試用） */
  get rigged(): boolean {
    return this.view instanceof RiggedSoldier;
  }

  get root(): THREE.Group {
    return this.view.root;
  }

  get muzzle(): THREE.Object3D {
    return this.view.muzzle;
  }

  get animation(): SoldierAnimation | null {
    return this.view.animation;
  }

  play(animation: SoldierAnimation, fade = 0.2): void {
    this.view.play(animation, fade);
  }

  setSpotted(spotted: boolean): void {
    this.view.setSpotted(spotted);
  }

  update(frameSeconds: number, pitch: number): void {
    this.view.update(frameSeconds, pitch);
  }

  dispose(): void {
    this.view.dispose();
  }
}

/** 程序產生的暫代士兵（關節 + 方塊），以 THREE.AnimationMixer 播放程式建立的關鍵影格並交叉淡入淡出。 */
class ProceduralSoldier implements SoldierView {
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<SoldierAnimation, THREE.AnimationAction>();
  private current: SoldierAnimation | null = null;
  private readonly chest: THREE.Object3D;
  private readonly head: THREE.Object3D;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  readonly muzzle = new THREE.Object3D();
  private readonly marker: THREE.Mesh;

  constructor(team: SoldierTeam | null, name: string) {
    this.root.name = name;
    const colors = TEAM_COLORS[team ?? 'neutral'];
    const uniform = this.material(colors.uniform, 0.9);
    const gear = this.material(0x2e3128, 0.8);
    const skin = this.material(0xc8a080, 0.7);
    const accent = this.material(colors.accent, 0.6);

    const joint = (jointName: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
      const o = new THREE.Group();
      o.name = jointName;
      o.position.set(x, y, z);
      parent.add(o);
      return o;
    };
    const part = (parent: THREE.Object3D, w: number, h: number, d: number, material: THREE.Material, x = 0, y = 0, z = 0) => {
      const geometry = new THREE.BoxGeometry(w, h, d);
      this.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    const hips = joint('hips', this.root, 0, 0.95, 0);
    part(hips, 0.34, 0.16, 0.22, uniform, 0, 0, 0);
    const spine = joint('spine', hips, 0, 0.08, 0);
    part(spine, 0.38, 0.3, 0.22, uniform, 0, 0.15, 0);
    this.chest = joint('chest', spine, 0, 0.3, 0);
    part(this.chest, 0.42, 0.24, 0.26, gear, 0, 0.06, 0); // 防彈背心
    part(this.chest, 0.43, 0.05, 0.27, accent, 0, 0.19, 0); // 隊伍識別帶
    this.head = joint('head', this.chest, 0, 0.24, 0);
    part(this.head, 0.19, 0.22, 0.21, skin, 0, 0.1, 0);
    part(this.head, 0.24, 0.12, 0.26, gear, 0, 0.2, 0.01); // 頭盔
    const lUpper = joint('lUpperArm', this.chest, -0.25, 0.14, 0);
    part(lUpper, 0.1, 0.3, 0.1, uniform, 0, -0.15, 0);
    const lFore = joint('lForearm', lUpper, 0, -0.3, 0);
    part(lFore, 0.09, 0.28, 0.09, uniform, 0, -0.14, 0);
    const rUpper = joint('rUpperArm', this.chest, 0.25, 0.14, 0);
    part(rUpper, 0.1, 0.3, 0.1, uniform, 0, -0.15, 0);
    const rFore = joint('rForearm', rUpper, 0, -0.3, 0);
    part(rFore, 0.09, 0.28, 0.09, uniform, 0, -0.14, 0);
    // 步槍跟著胸口（瞄準方向）
    const rifle = new THREE.Group();
    rifle.position.set(0.1, 0.02, -0.25);
    this.chest.add(rifle);
    part(rifle, 0.05, 0.08, 0.75, gear, 0, 0, 0);
    this.muzzle.position.set(0, 0.02, -0.42);
    rifle.add(this.muzzle);
    for (const side of [-1, 1] as const) {
      const thigh = joint(side < 0 ? 'lThigh' : 'rThigh', hips, side * 0.1, -0.05, 0);
      part(thigh, 0.14, 0.44, 0.15, uniform, 0, -0.22, 0);
      const shin = joint(side < 0 ? 'lShin' : 'rShin', thigh, 0, -0.44, 0);
      part(shin, 0.12, 0.42, 0.13, uniform, 0, -0.21, 0);
      part(shin, 0.13, 0.08, 0.24, gear, 0, -0.43, -0.04); // 靴子
    }
    // 頭頂標記：被標定時顯示
    const markerGeometry = new THREE.OctahedronGeometry(0.12, 0);
    this.geometries.push(markerGeometry);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff3020, depthTest: false, transparent: true });
    this.materials.push(markerMaterial);
    this.marker = new THREE.Mesh(markerGeometry, markerMaterial);
    this.marker.position.set(0, 2.2, 0);
    this.marker.visible = false;
    this.marker.renderOrder = 10;
    this.root.add(this.marker);

    this.mixer = new THREE.AnimationMixer(this.root);
    for (const [key, clip] of Object.entries(CLIPS) as Array<[SoldierAnimation, THREE.AnimationClip]>) {
      const action = this.mixer.clipAction(clip);
      if (key === 'death') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(key, action);
    }
    this.play('idle', 0);
  }

  private material(color: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness });
    this.materials.push(m);
    return m;
  }

  play(animation: SoldierAnimation, fade = 0.2): void {
    if (animation === this.current) {
      return;
    }
    const next = this.actions.get(animation)!;
    next.reset().setEffectiveWeight(1).play();
    const previous = this.current ? this.actions.get(this.current) : null;
    if (previous && fade > 0) {
      next.crossFadeFrom(previous, fade, false);
    } else {
      previous?.stop();
    }
    this.current = animation;
  }

  get animation(): SoldierAnimation | null {
    return this.current;
  }

  setSpotted(spotted: boolean): void {
    this.marker.visible = spotted;
  }

  /** 推進動畫，並把瞄準仰角套在胸口與頭部（動畫片段不控制這兩個關節）。 */
  update(frameSeconds: number, pitch: number): void {
    this.mixer.update(frameSeconds);
    const dead = this.current === 'death' || this.current === 'downed';
    const prone = this.current === 'prone' || this.current === 'crawl';
    const aim = dead ? 0 : prone ? pitch * 0.4 + 1.45 : pitch * 0.7;
    this.chest.rotation.set(aim, 0, 0);
    this.head.rotation.set(dead ? 0 : prone ? -0.2 : pitch * 0.3, 0, 0);
    if (this.marker.visible) {
      this.marker.rotation.y += frameSeconds * 3;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    for (const g of this.geometries) {
      g.dispose();
    }
    for (const m of this.materials) {
      m.dispose();
    }
  }
}
