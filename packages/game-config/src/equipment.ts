export interface GrenadeDefinition {
  id: string;
  displayName: string;
  /** 投擲初速（公尺／秒） */
  throwSpeed: number;
  fuseSeconds: number;
  cooldownSeconds: number;
  damage: number;
  minDamage: number;
  innerRadius: number;
  outerRadius: number;
  /** 反彈時保留的速度比例 */
  restitution: number;
}

/** 數值來源：舊版 UE5 FLEquipmentData（公分已換算為公尺）。 */
export const GRENADES: readonly GrenadeDefinition[] = [
  {
    id: 'frag',
    displayName: '破片手榴彈',
    throwSpeed: 15,
    fuseSeconds: 3.5,
    cooldownSeconds: 1,
    damage: 120,
    minDamage: 5,
    innerRadius: 2.5,
    outerRadius: 8,
    restitution: 0.35,
  },
];

export function getGrenade(id: string): GrenadeDefinition {
  const grenade = GRENADES.find((g) => g.id === id);
  if (!grenade) {
    throw new Error(`未知的手榴彈 id：${id}`);
  }
  return grenade;
}

/** 爆炸傷害：內半徑內全額，外半徑線性遞減到最小值，超過外半徑為 0。 */
export function explosionDamage(grenade: GrenadeDefinition, distance: number): number {
  if (distance <= grenade.innerRadius) {
    return grenade.damage;
  }
  if (distance >= grenade.outerRadius) {
    return 0;
  }
  const t = (distance - grenade.innerRadius) / (grenade.outerRadius - grenade.innerRadius);
  return grenade.damage + (grenade.minDamage - grenade.damage) * t;
}
