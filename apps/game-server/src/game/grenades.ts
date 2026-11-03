import { explosionDamage, getGrenade, type GrenadeDefinition } from '@frontline/game-config';
import type { Vec3 } from '@frontline/shared';
import type { SimWorld } from '@frontline/simulation';

export interface Grenade {
  id: number;
  owner: number;
  def: GrenadeDefinition;
  position: Vec3;
  velocity: Vec3;
  explodeAt: number;
  resting: boolean;
}

const GRAVITY = 9.81;

/** 手榴彈的彈道：重力、對地圖碰撞反彈、靜止。爆炸由 Match 處理傷害。 */
export function stepGrenade(g: Grenade, sim: SimWorld, dt: number): void {
  if (g.resting) {
    return;
  }
  g.velocity.y -= GRAVITY * dt;
  const move = { x: g.velocity.x * dt, y: g.velocity.y * dt, z: g.velocity.z * dt };
  const distance = Math.hypot(move.x, move.y, move.z);
  if (distance < 1e-5) {
    return;
  }
  const dir = { x: move.x / distance, y: move.y / distance, z: move.z / distance };
  const hit = sim.castBullet(g.position, dir, distance + 0.08);
  if (hit) {
    const n = hit.normal;
    const vn = g.velocity.x * n.x + g.velocity.y * n.y + g.velocity.z * n.z;
    // 反射並衰減
    g.velocity = {
      x: (g.velocity.x - 2 * vn * n.x) * g.def.restitution,
      y: (g.velocity.y - 2 * vn * n.y) * g.def.restitution,
      z: (g.velocity.z - 2 * vn * n.z) * g.def.restitution,
    };
    g.position = { x: hit.point.x + n.x * 0.08, y: hit.point.y + n.y * 0.08, z: hit.point.z + n.z * 0.08 };
    if (n.y > 0.7 && Math.hypot(g.velocity.x, g.velocity.y, g.velocity.z) < 1.2) {
      g.resting = true;
      g.velocity = { x: 0, y: 0, z: 0 };
    }
    return;
  }
  g.position = { x: g.position.x + move.x, y: g.position.y + move.y, z: g.position.z + move.z };
}

export function createGrenade(id: number, owner: number, defId: string, origin: Vec3, direction: Vec3, inherit: Vec3, now: number): Grenade {
  const def = getGrenade(defId);
  return {
    id,
    owner,
    def,
    position: { ...origin },
    velocity: {
      x: direction.x * def.throwSpeed + inherit.x,
      y: direction.y * def.throwSpeed + Math.max(0, inherit.y),
      z: direction.z * def.throwSpeed + inherit.z,
    },
    explodeAt: now + def.fuseSeconds,
    resting: false,
  };
}

export { explosionDamage };
