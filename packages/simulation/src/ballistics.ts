import type { WeaponDefinition } from '@frontline/game-config';
import { createRng, hashSeed, randomInCone, type Stance, type Vec3 } from '@frontline/shared';
import type { HitZone } from './hitboxes';

const DEG = Math.PI / 180;

export interface SpreadContext {
  aiming: boolean;
  stance: Stance;
  moving: boolean;
  airborne: boolean;
  /** 連射累積的擴散（度） */
  bloom: number;
}

/** 目前的散佈圓錐半角（度）。與舊版 UE5 的公式相同，前後端共用。 */
export function spreadDegrees(weapon: WeaponDefinition, ctx: SpreadContext): number {
  const s = weapon.spread;
  let spread = ctx.aiming ? s.aim : s.hip;
  if (ctx.stance === 'crouching') {
    spread *= s.crouchMultiplier;
  } else if (ctx.stance === 'prone') {
    spread *= s.proneMultiplier;
  }
  if (ctx.airborne) {
    spread *= s.airborneMultiplier;
  } else if (ctx.moving) {
    spread *= s.movingMultiplier;
  }
  return spread + ctx.bloom * (ctx.aiming ? 0.5 : 1);
}

/**
 * 射擊的亂數種子：由伺服器配發的對戰種子、玩家編號、武器欄位與射擊序號推算。
 * 兩端算得出同一個值，但客戶端無法挑選（舊版 UE5 讓客戶端自選種子，可被作弊利用）。
 */
export function shotSeed(matchSeed: number, playerNumber: number, slot: number, shotSeq: number): number {
  return hashSeed(matchSeed, playerNumber, slot, shotSeq);
}

/** 依種子算出每顆彈丸的方向。 */
export function pelletDirections(weapon: WeaponDefinition, aim: Vec3, spreadDeg: number, seed: number): Vec3[] {
  const rng = createRng(seed);
  const center = randomInCone(rng, aim, spreadDeg * DEG);
  const pellets = Math.max(1, weapon.damage.pellets);
  if (pellets === 1) {
    return [center];
  }
  const result: Vec3[] = [];
  for (let i = 0; i < pellets; i++) {
    result.push(randomInCone(rng, center, weapon.damage.pelletSpreadDegrees * DEG));
  }
  return result;
}

export function zoneMultiplier(weapon: WeaponDefinition, zone: HitZone): number {
  if (zone === 'head') {
    return weapon.damage.headMultiplier;
  }
  return zone === 'limb' ? weapon.damage.limbMultiplier : 1;
}
