import type { Stance, Vec3 } from '@frontline/shared';
import { raycastHitbox, type HitZone, type SimWorld } from '@frontline/simulation';
import * as THREE from 'three';
import { SoldierModel } from '../animation/SoldierModel';

interface Dummy {
  model: SoldierModel;
  home: Vec3;
  feet: Vec3;
  stance: Stance;
  yaw: number;
  health: number;
  respawnAt: number;
  strafe: number;
  phase: number;
}

export interface DummyHit {
  index: number;
  zone: HitZone;
  distance: number;
}

/**
 * 靶場的假人：使用與伺服器相同的 hitbox 判定，被擊殺後 3 秒復活。
 * 部分假人會左右移動、部分蹲下或臥倒。
 */
export class TargetDummies {
  private readonly dummies: Dummy[] = [];
  private readonly group = new THREE.Group();

  constructor(
    scene: THREE.Scene,
    sim: SimWorld,
    spawn: { position: readonly [number, number, number]; yaw: number },
  ) {
    this.group.name = 'target-dummies';
    scene.add(this.group);
    const layout: Array<[number, number, Stance, number]> = [
      // [前方距離, 側向偏移, 姿勢, 左右移動幅度]
      [10, -3, 'standing', 0],
      [14, 3, 'crouching', 0],
      [22, 0, 'standing', 3],
      [30, -5, 'standing', 0],
      [38, 4, 'prone', 0],
      [50, 0, 'standing', 4],
    ];
    const [sx, , sz] = spawn.position;
    const fx = -Math.sin(spawn.yaw);
    const fz = -Math.cos(spawn.yaw);
    layout.forEach(([forward, side, stance, strafe], i) => {
      const x = sx + fx * forward + -fz * side;
      const z = sz + fz * forward + fx * side;
      const y = sim.groundHeight(x, z) ?? spawn.position[1];
      const model = new SoldierModel(i % 2 === 0 ? 'bravo' : 'alpha', `dummy-${i}`);
      const home = { x, y, z };
      this.group.add(model.root);
      this.dummies.push({ model, home, feet: { ...home }, stance, yaw: spawn.yaw + Math.PI, health: 100, respawnAt: 0, strafe, phase: i });
    });
  }

  get count(): number {
    return this.dummies.length;
  }

  aliveCount(): number {
    return this.dummies.filter((d) => d.health > 0).length;
  }

  /** 射線打到哪個假人（maxDistance 通常是打到地圖的距離，避免穿牆）。 */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): DummyHit | null {
    let best: DummyHit | null = null;
    this.dummies.forEach((d, index) => {
      if (d.health <= 0) {
        return;
      }
      const hit = raycastHitbox({ feet: d.feet, yaw: d.yaw, stance: d.stance }, origin, direction, maxDistance);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { index, zone: hit.zone, distance: hit.distance };
      }
    });
    return best;
  }

  /** 套用傷害，回傳是否擊殺。 */
  damage(index: number, amount: number, now: number): boolean {
    const d = this.dummies[index];
    if (!d || d.health <= 0) {
      return false;
    }
    d.health -= amount;
    if (d.health <= 0) {
      d.respawnAt = now + 3;
      d.model.play('death', 0.05);
      return true;
    }
    return false;
  }

  update(now: number, frameSeconds: number): void {
    for (const d of this.dummies) {
      if (d.health <= 0) {
        if (now >= d.respawnAt) {
          d.health = 100;
          d.feet = { ...d.home };
        }
      } else if (d.strafe > 0) {
        const offset = Math.sin(now * 0.8 + d.phase) * d.strafe;
        d.feet = { x: d.home.x + Math.cos(d.yaw) * offset, y: d.home.y, z: d.home.z - Math.sin(d.yaw) * offset };
      }
      const moving = d.strafe > 0 && d.health > 0;
      if (d.health > 0) {
        d.model.play(d.stance === 'prone' ? 'prone' : d.stance === 'crouching' ? 'crouchIdle' : moving ? 'walk' : 'idle');
      }
      d.model.root.position.set(d.feet.x, d.feet.y, d.feet.z);
      d.model.root.rotation.y = d.yaw;
      d.model.update(frameSeconds, 0);
    }
  }

  dispose(): void {
    for (const d of this.dummies) {
      d.model.dispose();
    }
    this.group.removeFromParent();
  }
}
