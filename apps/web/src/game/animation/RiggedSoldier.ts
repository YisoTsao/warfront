import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { SoldierAnimation, SoldierTeam, SoldierView } from './SoldierModel';

/**
 * 骨架士兵（glTF，Quaternius SWAT，CC0）：
 * - 待機（持槍）、走、跑、死亡用模型附的動畫片段，以 AnimationMixer 播放並交叉淡入淡出；
 * - 其餘姿勢由程式疊加在動畫結果上：
 *   蹲下 = 骨盆下移 + 腿部兩骨 IK（腳維持在動畫的位置）；臥倒 = 整個身體繞腳底往前趴；
 *   持槍 = 步槍（AK，CC0）掛在右肩、跟著瞄準仰角，雙手以兩骨 IK 握住握把與護木；上半身依仰角前後彎。
 * 所有實例共用一份幾何、材質與動畫片段（SkeletonUtils.clone 只複製骨架與節點）。
 */

const SOLDIER_URL = '/characters/soldier/soldier.glb';
const RIFLE_URL = '/characters/weapons/ak.glb';
const TARGET_HEIGHT = 1.8;

interface SoldierAsset {
  scene: THREE.Object3D;
  /** 步槍：槍托在原點、槍口朝 −Z（tools/map-build 的 characters 腳本已轉好） */
  rifle: THREE.Object3D | null;
  clips: Map<string, THREE.AnimationClip>;
  /** 把模型縮放到 TARGET_HEIGHT、腳底放在 y = 0 */
  scale: number;
  footOffset: number;
  materials: Map<SoldierTeam, Map<THREE.Material, THREE.Material>>;
}

let asset: SoldierAsset | null = null;
let pending: Promise<boolean> | null = null;

/** 預先下載士兵模型；失敗時回傳 false，士兵改用程序產生的暫代模型。 */
export function preloadSoldierAsset(url = SOLDIER_URL, rifleUrl = RIFLE_URL): Promise<boolean> {
  const loader = new GLTFLoader();
  pending ??= Promise.all([loader.loadAsync(url), loader.loadAsync(rifleUrl).catch(() => null)])
    .then(([gltf, rifleGltf]) => {
      const scene = gltf.scene;
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      const height = box.max.y - box.min.y;
      const scale = height > 0.1 ? TARGET_HEIGHT / height : 1;
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
          // 骨架動畫會超出綁定姿勢的包圍盒（臥倒時尤其明顯），不做視錐剔除
          o.frustumCulled = false;
        }
      });
      const rifle = rifleGltf?.scene ?? null;
      rifle?.traverse((o) => {
        o.castShadow = true;
      });
      asset = {
        scene,
        rifle,
        clips: new Map(gltf.animations.map((c) => [c.name.replace(/^.*\|/, ''), c])),
        scale,
        footOffset: -box.min.y * scale,
        materials: new Map(),
      };
      return true;
    })
    .catch((error: unknown) => {
      console.warn('士兵模型載入失敗，改用暫代模型', error);
      return false;
    });
  return pending;
}

export function soldierAssetReady(): boolean {
  return asset !== null;
}

/** 隊伍制服顏色：取代模型主要布料材質（Swat）的顏色，同一隊共用同一組材質。 */
const TEAM_UNIFORM: Record<SoldierTeam, number | null> = { alpha: 0x56653f, bravo: 0x9a8258, neutral: null };
const UNIFORM_MATERIAL = 'Swat';
const TEAM_ACCENT: Record<SoldierTeam, number> = { alpha: 0x3a6ab8, bravo: 0xb84a30, neutral: 0xc0c0c0 };

function teamMaterial(source: THREE.Material, team: SoldierTeam): THREE.Material {
  const cache = asset!.materials.get(team) ?? new Map<THREE.Material, THREE.Material>();
  asset!.materials.set(team, cache);
  let material = cache.get(source);
  if (!material) {
    material = source.clone();
    const uniform = TEAM_UNIFORM[team];
    if (uniform !== null && source.name === UNIFORM_MATERIAL && 'color' in material && material.color instanceof THREE.Color) {
      material.color.set(uniform);
    }
    cache.set(source, material);
  }
  return material;
}

// ---- 兩骨 IK ----

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();

/** 以世界座標旋轉骨頭：把世界方向 from 轉到 to。 */
function rotateBoneWorld(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  _q.setFromUnitVectors(from.normalize(), to.normalize());
  bone.parent!.getWorldQuaternion(_pq);
  // local' = parent⁻¹ · q · parent · local
  bone.quaternion.premultiply(_pq).premultiply(_q).premultiply(_pq.invert());
  bone.updateMatrixWorld(true);
}

/**
 * 兩骨 IK：upper → lower → end，讓 end 到達 target，彎曲方向朝 pole。
 * 只改 upper 與 lower 的旋轉；end（手、腳）維持動畫的相對旋轉。
 */
function solveTwoBone(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  const a = upper.getWorldPosition(_a);
  const b = lower.getWorldPosition(_b);
  const c = end.getWorldPosition(_c);
  const lenAB = a.distanceTo(b);
  const lenBC = b.distanceTo(c);
  const toTarget = _d.subVectors(target, a);
  const dist = THREE.MathUtils.clamp(toTarget.length(), Math.abs(lenAB - lenBC) + 1e-3, lenAB + lenBC - 1e-3);
  const dir = toTarget.normalize();
  // 彎曲平面：pole 去掉沿目標方向的分量
  const bend = _e.subVectors(pole, a);
  bend.addScaledVector(dir, -bend.dot(dir));
  if (bend.lengthSq() < 1e-8) {
    bend.set(0, -1, 0);
  }
  bend.normalize();
  const cosA = THREE.MathUtils.clamp((lenAB * lenAB + dist * dist - lenBC * lenBC) / (2 * lenAB * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // 上段骨頭：(b − a) → 期望的關節位置
  const desiredB = new THREE.Vector3().copy(a).addScaledVector(dir, cosA * lenAB).addScaledVector(bend, sinA * lenAB);
  rotateBoneWorld(upper, b.clone().sub(a), desiredB.clone().sub(a));
  // 下段骨頭：(c − b') → (target − b')
  const nb = lower.getWorldPosition(new THREE.Vector3());
  const nc = end.getWorldPosition(new THREE.Vector3());
  const reach = new THREE.Vector3().copy(a).addScaledVector(dir, dist);
  rotateBoneWorld(lower, nc.sub(nb), reach.sub(nb));
}

/** 動畫狀態 → 使用的動畫片段與播放速度（once：只播一次並停在最後一格；atEnd：直接停在最後一格） */
const BASE: Record<SoldierAnimation, { clip: string; speed: number; once?: boolean; atEnd?: boolean }> = {
  idle: { clip: 'Idle_Gun', speed: 1 },
  walk: { clip: 'Walk', speed: 1 },
  run: { clip: 'Run', speed: 1 },
  crouchIdle: { clip: 'Idle_Gun', speed: 0.6 },
  crouchWalk: { clip: 'Walk', speed: 0.75 },
  prone: { clip: 'Idle_Gun', speed: 0.3 },
  crawl: { clip: 'Walk', speed: 0.5 },
  airborne: { clip: 'Idle_Gun', speed: 0.2 },
  downed: { clip: 'Death', speed: 1, once: true, atEnd: true },
  death: { clip: 'Death', speed: 1, once: true },
};

const CROUCH_DROP = 0.42;

export class RiggedSoldier implements SoldierView {
  readonly root = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  private readonly body = new THREE.Group();
  private readonly rifle = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly ownGeometries: THREE.BufferGeometry[] = [];
  private readonly ownMaterials: THREE.Material[] = [];
  private readonly marker: THREE.Mesh;
  private readonly bones: Record<
    'body' | 'spine1' | 'spine2' | 'lArm' | 'lFore' | 'lHand' | 'rArm' | 'rFore' | 'rHand' | 'lUpLeg' | 'lLeg' | 'lAnkle' | 'lFoot' | 'rUpLeg' | 'rLeg' | 'rAnkle' | 'rFoot',
    THREE.Object3D
  >;
  private readonly rightGrip = new THREE.Object3D();
  private readonly leftGrip = new THREE.Object3D();
  private current: SoldierAnimation | null = null;
  private currentClip: string | null = null;
  private crouch = 0;
  private lying = 0;

  constructor(team: SoldierTeam, name: string) {
    const a = asset!;
    this.root.name = name;
    const model = cloneSkinned(a.scene);
    model.scale.multiplyScalar(a.scale);
    model.position.y = a.footOffset;
    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => teamMaterial(m, team)) : teamMaterial(mesh.material, team);
      }
    });
    this.body.add(model);
    this.root.add(this.body);

    // GLTFLoader 會把節點名稱裡的「.」拿掉：UpperArm.L → UpperArmL。
    // 這副骨架（Blender Rigify 風格）的腿掛在 Body 下、與 Hips 平行；腳骨掛在 Root 下當 IK 控制點，
    // 所以小腿的末端（LowerLeg_end）才是腳踝，腳骨的位置是腳踝該到的地方。
    const bone = (n: string) => {
      const found = model.getObjectByName(n);
      if (!found) {
        throw new Error(`士兵模型缺少骨頭 ${n}`);
      }
      return found;
    };
    this.bones = {
      body: bone('Body'),
      spine1: bone('Torso'),
      spine2: bone('Chest'),
      lArm: bone('UpperArmL'),
      lFore: bone('LowerArmL'),
      lHand: bone('WristL'),
      rArm: bone('UpperArmR'),
      rFore: bone('LowerArmR'),
      rHand: bone('WristR'),
      lUpLeg: bone('UpperLegL'),
      lLeg: bone('LowerLegL'),
      lAnkle: bone('LowerLegL_end'),
      lFoot: bone('FootL'),
      rUpLeg: bone('UpperLegR'),
      rLeg: bone('LowerLegR'),
      rAnkle: bone('LowerLegR_end'),
      rFoot: bone('FootR'),
    };

    // 隊伍識別臂章：掛在左右上臂，尺寸以公尺計，抵銷骨頭的世界縮放
    model.updateMatrixWorld(true);
    const accent = new THREE.MeshStandardMaterial({ color: TEAM_ACCENT[team], roughness: 0.6 });
    this.ownMaterials.push(accent);
    const bandGeometry = new THREE.CylinderGeometry(0.062, 0.062, 0.06, 10, 1, true);
    this.ownGeometries.push(bandGeometry);
    for (const arm of [this.bones.lArm, this.bones.rArm]) {
      const band = new THREE.Mesh(bandGeometry, accent);
      const worldScale = arm.getWorldScale(new THREE.Vector3()).x;
      band.scale.setScalar(1 / worldScale);
      band.position.set(0, 0.11 / worldScale, 0);
      arm.add(band);
    }

    this.buildRifle();

    const markerGeometry = new THREE.OctahedronGeometry(0.12, 0);
    this.ownGeometries.push(markerGeometry);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff3020, depthTest: false, transparent: true });
    this.ownMaterials.push(markerMaterial);
    this.marker = new THREE.Mesh(markerGeometry, markerMaterial);
    this.marker.position.set(0, 2.2, 0);
    this.marker.visible = false;
    this.marker.renderOrder = 10;
    this.root.add(this.marker);

    this.mixer = new THREE.AnimationMixer(model);
    for (const base of Object.values(BASE)) {
      const clip = a.clips.get(base.clip);
      if (clip && !this.actions.has(base.clip)) {
        this.actions.set(base.clip, this.mixer.clipAction(clip));
      }
    }
    this.play('idle', 0);
  }

  /** 步槍：原點在槍托（貼右肩），槍口朝 −Z；沒有步槍模型時用方塊拼一把。 */
  private buildRifle(): void {
    if (asset!.rifle) {
      this.rifle.add(asset!.rifle.clone());
    } else {
      const metal = new THREE.MeshStandardMaterial({ color: 0x23251f, roughness: 0.55, metalness: 0.4 });
      this.ownMaterials.push(metal);
      const geometry = new THREE.BoxGeometry(0.05, 0.09, 0.9);
      this.ownGeometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, metal);
      mesh.position.z = -0.45;
      mesh.castShadow = true;
      this.rifle.add(mesh);
    }
    this.muzzle.position.set(0, 0.03, -0.92);
    this.rightGrip.position.set(0, -0.06, -0.26);
    this.leftGrip.position.set(-0.01, -0.03, -0.55);
    this.rifle.add(this.muzzle, this.rightGrip, this.leftGrip);
    this.root.add(this.rifle);
  }

  play(animation: SoldierAnimation, fade = 0.2): void {
    if (animation === this.current) {
      return;
    }
    this.current = animation;
    const base = BASE[animation];
    const next = this.actions.get(base.clip);
    if (!next) {
      return;
    }
    next.timeScale = base.speed;
    if (base.clip === this.currentClip) {
      return;
    }
    next.setLoop(base.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = base.once === true;
    next.reset().setEffectiveWeight(1).play();
    if (base.atEnd) {
      next.time = next.getClip().duration;
    }
    const previous = this.currentClip ? this.actions.get(this.currentClip) : null;
    if (previous && fade > 0) {
      next.crossFadeFrom(previous, fade, false);
    } else {
      previous?.stop();
    }
    this.currentClip = base.clip;
  }

  get animation(): SoldierAnimation | null {
    return this.current;
  }

  setSpotted(spotted: boolean): void {
    this.marker.visible = spotted;
  }

  update(frameSeconds: number, pitch: number): void {
    this.mixer.update(frameSeconds);
    const anim = this.current;
    const dead = anim === 'death' || anim === 'downed';
    const prone = anim === 'prone' || anim === 'crawl';
    const crouching = anim === 'crouchIdle' || anim === 'crouchWalk';
    const blend = 1 - Math.exp(-frameSeconds * 10);
    this.crouch += ((crouching ? 1 : 0) - this.crouch) * blend;
    this.lying += ((prone ? 1 : 0) - this.lying) * blend;

    // ---- 臥倒：整個身體繞腳底往前趴（死亡與倒地用模型的 Death 動畫） ----
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    if (!dead && this.lying > 0.001) {
      this.body.rotation.x = -(Math.PI / 2) * this.lying;
      this.body.position.set(0, 0.14 * this.lying, 0.95 * this.lying);
    }
    this.root.updateMatrixWorld(true);

    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.body.getWorldQuaternion(new THREE.Quaternion()));
    const rootQuat = this.root.getWorldQuaternion(new THREE.Quaternion());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(rootQuat);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rootQuat);

    // ---- 蹲下：身體下移，腳留在原位（腳骨不動），膝蓋往前彎 ----
    if (this.crouch > 0.001 && !dead) {
      const { body, lUpLeg, lLeg, lAnkle, lFoot, rUpLeg, rLeg, rAnkle, rFoot } = this.bones;
      const bodyWorld = body.getWorldPosition(new THREE.Vector3()).addScaledVector(up, -CROUCH_DROP * this.crouch).addScaledVector(forward, -0.08 * this.crouch);
      body.position.copy(body.parent!.worldToLocal(bodyWorld));
      body.updateMatrixWorld(true);
      solveTwoBone(lUpLeg, lLeg, lAnkle, lFoot.getWorldPosition(new THREE.Vector3()), lLeg.getWorldPosition(new THREE.Vector3()).addScaledVector(forward, 1));
      solveTwoBone(rUpLeg, rLeg, rAnkle, rFoot.getWorldPosition(new THREE.Vector3()), rLeg.getWorldPosition(new THREE.Vector3()).addScaledVector(forward, 1));
    }

    // ---- 上半身跟著瞄準仰角（臥倒時由步槍角度負責大部分） ----
    const aim = dead ? 0 : pitch * (prone ? 0.25 : 0.5);
    if (aim !== 0) {
      const axis = right.clone();
      for (const spine of [this.bones.spine1, this.bones.spine2]) {
        const from = new THREE.Vector3(0, 0, -1).applyQuaternion(rootQuat);
        const to = from.clone().applyAxisAngle(axis, aim * 0.5);
        rotateBoneWorld(spine, from, to);
      }
    }

    // ---- 步槍與雙手 ----
    this.rifle.visible = !dead;
    if (!dead) {
      const shoulder = this.bones.rArm.getWorldPosition(new THREE.Vector3());
      // 槍托貼在右肩前方一點，槍口方向 = 身體前方往上 pitch
      shoulder.addScaledVector(forward, 0.08).addScaledVector(right, -0.04).addScaledVector(up, -0.06);
      this.rifle.position.copy(this.root.worldToLocal(shoulder));
      this.rifle.rotation.set(prone ? pitch * 0.5 : pitch, 0, 0);
      this.rifle.updateMatrixWorld(true);
      const down = up.clone().negate();
      const { lArm, lFore, lHand, rArm, rFore, rHand } = this.bones;
      solveTwoBone(
        rArm,
        rFore,
        rHand,
        this.rightGrip.getWorldPosition(new THREE.Vector3()),
        rFore.getWorldPosition(new THREE.Vector3()).addScaledVector(down, 1).addScaledVector(right, 0.8).addScaledVector(forward, -0.3),
      );
      solveTwoBone(
        lArm,
        lFore,
        lHand,
        this.leftGrip.getWorldPosition(new THREE.Vector3()),
        lFore.getWorldPosition(new THREE.Vector3()).addScaledVector(down, 1).addScaledVector(right, -0.6),
      );
    }

    if (this.marker.visible) {
      this.marker.rotation.y += frameSeconds * 3;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.root.removeFromParent();
    for (const g of this.ownGeometries) {
      g.dispose();
    }
    for (const m of this.ownMaterials) {
      m.dispose();
    }
  }
}
