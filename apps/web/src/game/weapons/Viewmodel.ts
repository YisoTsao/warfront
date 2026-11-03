import type { WeaponDefinition } from '@frontline/game-config';
import * as THREE from 'three';

const HIP_POSITION = new THREE.Vector3(0.17, -0.17, -0.36);
const ADS_POSITION = new THREE.Vector3(0, -0.068, -0.26);
const SPRINT_ROTATION = new THREE.Euler(-0.25, 0.7, 0.35);

export interface ViewmodelState {
  adsAlpha: number;
  horizontalSpeed: number;
  sprinting: boolean;
  grounded: boolean;
  /** 0–1 的換彈進度；沒有在換彈時為 null */
  reloadProgress: number | null;
  /** 0–1 的切槍（舉槍）進度；完成為 1 */
  equipProgress: number;
  lookDx: number;
  lookDy: number;
  visible: boolean;
}

/**
 * 第一人稱武器模型。沒有美術資產前，依武器的 presentation 數值程序產生；
 * 之後有 modelPath 時改載入 glTF，介面不變。
 */
export class Viewmodel {
  readonly root = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly models = new Map<string, THREE.Group>();
  private current: THREE.Group | null = null;
  private readonly muzzle = new THREE.Object3D();
  private bobPhase = 0;
  private kickBack = 0;
  private kickUp = 0;
  private swayX = 0;
  private swayY = 0;
  private sprintAlpha = 0;

  constructor(parent: THREE.Object3D) {
    this.root.add(this.pivot);
    parent.add(this.root);
  }

  setWeapon(def: WeaponDefinition): void {
    let model = this.models.get(def.id);
    if (!model) {
      model = buildWeaponModel(def);
      this.models.set(def.id, model);
    }
    if (this.current) {
      this.pivot.remove(this.current);
    }
    this.current = model;
    this.pivot.add(model);
    const muzzle = model.getObjectByName('muzzle');
    this.muzzle.removeFromParent();
    (muzzle ?? model).add(this.muzzle);
  }

  /** 開槍時的模型後座（視覺），強度依武器而定。 */
  kick(strength: number): void {
    this.kickBack = Math.min(0.09, this.kickBack + 0.025 * strength);
    this.kickUp = Math.min(0.2, this.kickUp + 0.05 * strength);
  }

  update(frameSeconds: number, s: ViewmodelState): void {
    this.root.visible = s.visible;
    if (!s.visible) {
      return;
    }
    const ads = smooth(s.adsAlpha);
    this.sprintAlpha += ((s.sprinting && ads < 0.1 ? 1 : 0) - this.sprintAlpha) * Math.min(1, frameSeconds * 8);

    // 走路晃動（ADS 時大幅降低）
    const moving = s.grounded ? Math.min(1, s.horizontalSpeed / 6) : 0;
    this.bobPhase += frameSeconds * (6 + s.horizontalSpeed * 1.6);
    const bobScale = moving * (1 - ads * 0.85);
    const bobX = Math.sin(this.bobPhase) * 0.012 * bobScale;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.014 * bobScale;

    // 視角移動造成的槍身延遲
    const swayTarget = (1 - ads * 0.7) * 0.0004;
    this.swayX += (-s.lookDx * swayTarget - this.swayX) * Math.min(1, frameSeconds * 10);
    this.swayY += (s.lookDy * swayTarget - this.swayY) * Math.min(1, frameSeconds * 10);

    this.kickBack *= Math.exp(-frameSeconds * 18);
    this.kickUp *= Math.exp(-frameSeconds * 14);

    const position = HIP_POSITION.clone().lerp(ADS_POSITION, ads);
    position.x += bobX + this.swayX;
    position.y += bobY - this.swayY;
    position.z += this.kickBack;

    let rx = this.kickUp + SPRINT_ROTATION.x * this.sprintAlpha;
    const ry = SPRINT_ROTATION.y * this.sprintAlpha + this.swayX * 2;
    let rz = SPRINT_ROTATION.z * this.sprintAlpha;

    if (s.reloadProgress !== null) {
      // 換彈：槍身下壓並側轉，結束前回正
      const k = Math.sin(Math.min(1, s.reloadProgress) * Math.PI);
      position.y -= 0.08 * k;
      rx -= 0.35 * k;
      rz += 0.6 * k;
    }
    const equip = 1 - smooth(s.equipProgress);
    position.y -= 0.25 * equip;
    rx -= 0.6 * equip;

    this.pivot.position.copy(position);
    this.pivot.rotation.set(rx, ry, rz);
  }

  muzzleWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.muzzle.getWorldPosition(target);
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const model of this.models.values()) {
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
  }
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** 以方塊與圓柱拼出槍：機匣、槍管、彈匣、槍托、瞄具。 */
export function buildWeaponModel(def: WeaponDefinition): THREE.Group {
  const p = def.presentation;
  const group = new THREE.Group();
  group.name = `weapon:${def.id}`;
  const body = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.55, metalness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1b1d1e', roughness: 0.6, metalness: 0.3 });
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.x = rx;
    group.add(mesh);
    return mesh;
  };
  const isPistol = def.category === 'pistol';
  const width = isPistol ? 0.03 : 0.045;
  // 機匣
  add(new THREE.BoxGeometry(width, p.bodyHeight, p.bodyLength), body, 0, 0, -p.bodyLength / 2 + 0.06);
  // 槍管
  const barrel = add(new THREE.CylinderGeometry(0.011, 0.011, p.barrelLength, 10), dark, 0, 0.012, -p.bodyLength + 0.06 - p.barrelLength / 2, Math.PI / 2);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, -p.barrelLength / 2 - 0.01, 0);
  barrel.add(muzzle);
  // 握把
  add(new THREE.BoxGeometry(width * 0.8, 0.09, 0.035), dark, 0, -0.07, 0.03, -0.25);
  if (!isPistol) {
    // 彈匣（霰彈槍沒有）
    if (def.category !== 'shotgun') {
      const magLength = def.category === 'lmg' ? 0.11 : 0.05;
      add(new THREE.BoxGeometry(width * 0.75, def.category === 'lmg' ? 0.08 : 0.13, magLength), dark, 0, -0.09, -0.12, 0.15);
    }
    // 槍托
    add(new THREE.BoxGeometry(width * 0.8, 0.07, 0.2), body, 0, -0.02, 0.17);
    // 護木
    add(new THREE.BoxGeometry(width * 1.1, p.bodyHeight * 0.85, p.bodyLength * 0.35), dark, 0, -0.005, -p.bodyLength + 0.18);
  }
  // 瞄具與紅點（ADS 時位於畫面中央）
  add(new THREE.BoxGeometry(0.03, 0.03, 0.06), dark, 0, p.bodyHeight / 2 + 0.018, -0.05);
  const dot = add(new THREE.SphereGeometry(0.002, 8, 8), new THREE.MeshBasicMaterial({ color: '#ff3020' }), 0, p.bodyHeight / 2 + 0.03, -0.075);
  dot.renderOrder = 2;
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.frustumCulled = false;
    }
  });
  return group;
}
