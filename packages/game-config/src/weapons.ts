/**
 * 武器定義。數值來源：舊版 UE5 骨架 legacy/ue5/Source/Frontline/Data/FLDefaultContent.cpp，
 * 距離單位已是公尺。新增武器只要新增資料，不需要改程式。
 */

export type WeaponCategory = 'assaultRifle' | 'smg' | 'dmr' | 'sniperRifle' | 'lmg' | 'shotgun' | 'pistol';
export type FireMode = 'single' | 'burst' | 'auto';
export type WeaponSlot = 'primary' | 'secondary';
export type AttachmentSlot = 'optic' | 'muzzle' | 'magazine';

export interface DamageProfile {
  /** 每顆彈丸的最大傷害（玩家血量 100） */
  maxDamage: number;
  minDamage: number;
  falloffStartMeters: number;
  falloffEndMeters: number;
  headMultiplier: number;
  limbMultiplier: number;
  maxRangeMeters: number;
  /** 霰彈槍 > 1 */
  pellets: number;
  /** 彈丸額外擴散（度） */
  pelletSpreadDegrees: number;
}

/** 散佈：圓錐半角（度） */
export interface SpreadProfile {
  hip: number;
  aim: number;
  perShot: number;
  maxBloom: number;
  bloomRecoveryPerSecond: number;
  movingMultiplier: number;
  airborneMultiplier: number;
  crouchMultiplier: number;
  proneMultiplier: number;
}

/** 視角後座力（度），只作用在開槍者自己的視角 */
export interface RecoilProfile {
  verticalKick: number;
  horizontalKick: number;
  /** -1 一律向左、0 隨機、1 一律向右 */
  horizontalBias: number;
  firstShotMultiplier: number;
  aimMultiplier: number;
  crouchMultiplier: number;
  proneMultiplier: number;
  /** 停止射擊後自動回復的比例 */
  recoveryFraction: number;
  recoveryDegreesPerSecond: number;
  recoveryDelaySeconds: number;
}

export interface WeaponPresentation {
  /** 視角模型尺寸（公尺）：機匣長、高、槍管長 */
  bodyLength: number;
  bodyHeight: number;
  barrelLength: number;
  color: string;
  /** 合成槍聲參數 */
  soundPitch: number;
  soundLength: number;
  muzzleFlashScale: number;
  tracerEvery: number;
  /** 之後接上美術資產時使用 */
  modelPath?: string;
  fireSound?: string;
  reloadSound?: string;
}

export interface WeaponDefinition {
  id: string;
  displayName: string;
  category: WeaponCategory;
  slot: WeaponSlot;
  fireModes: readonly FireMode[];
  roundsPerMinute: number;
  burstCount: number;
  magazineSize: number;
  maxReserveAmmo: number;
  reloadSeconds: number;
  emptyReloadSeconds: number;
  /** 逐發裝填（泵動霰彈槍） */
  reloadPerRound: boolean;
  perRoundReloadSeconds: number;
  equipSeconds: number;
  adsSeconds: number;
  /** ADS 時的水平視野（度） */
  adsFov: number;
  /** ADS 時的移動速度倍率（乘在移動規則的瞄準倍率之上） */
  adsMoveMultiplier: number;
  damage: DamageProfile;
  spread: SpreadProfile;
  recoil: RecoilProfile;
  attachmentSlots: readonly AttachmentSlot[];
  presentation: WeaponPresentation;
}

const BASE_SPREAD: SpreadProfile = {
  hip: 3,
  aim: 0.2,
  perShot: 0.25,
  maxBloom: 2.5,
  bloomRecoveryPerSecond: 6,
  movingMultiplier: 1.6,
  airborneMultiplier: 3,
  crouchMultiplier: 0.8,
  proneMultiplier: 0.6,
};

const BASE_RECOIL: RecoilProfile = {
  verticalKick: 0.4,
  horizontalKick: 0.15,
  horizontalBias: 0,
  firstShotMultiplier: 1.5,
  aimMultiplier: 0.75,
  crouchMultiplier: 0.85,
  proneMultiplier: 0.6,
  recoveryFraction: 0.6,
  recoveryDegreesPerSecond: 10,
  recoveryDelaySeconds: 0.1,
};

interface Spec {
  id: string;
  name: string;
  category: WeaponCategory;
  slot: WeaponSlot;
  modes: FireMode[];
  rpm: number;
  mag: number;
  reserve: number;
  reload: number;
  emptyReload: number;
  maxDamage: number;
  minDamage: number;
  falloffStart: number;
  falloffEnd: number;
  head: number;
  hip: number;
  aim: number;
  perShot: number;
  vKick: number;
  hKick: number;
  adsFov: number;
  adsTime: number;
  pellets?: number;
  pelletSpread?: number;
  perRound?: boolean;
  presentation: WeaponPresentation;
  overrides?: (w: WeaponDefinition) => void;
}

function makeWeapon(s: Spec): WeaponDefinition {
  const weapon: WeaponDefinition = {
    id: s.id,
    displayName: s.name,
    category: s.category,
    slot: s.slot,
    fireModes: s.modes,
    roundsPerMinute: s.rpm,
    burstCount: 3,
    magazineSize: s.mag,
    maxReserveAmmo: s.reserve,
    reloadSeconds: s.reload,
    emptyReloadSeconds: s.emptyReload,
    reloadPerRound: s.perRound ?? false,
    perRoundReloadSeconds: s.perRound ? s.reload : 0.55,
    equipSeconds: s.slot === 'secondary' ? 0.4 : 0.6,
    adsSeconds: s.adsTime,
    adsFov: s.adsFov,
    adsMoveMultiplier: 1,
    damage: {
      maxDamage: s.maxDamage,
      minDamage: s.minDamage,
      falloffStartMeters: s.falloffStart,
      falloffEndMeters: s.falloffEnd,
      headMultiplier: s.head,
      limbMultiplier: 0.9,
      maxRangeMeters: 1000,
      pellets: s.pellets ?? 1,
      pelletSpreadDegrees: s.pelletSpread ?? 0,
    },
    spread: { ...BASE_SPREAD, hip: s.hip, aim: s.aim, perShot: s.perShot },
    recoil: { ...BASE_RECOIL, verticalKick: s.vKick, horizontalKick: s.hKick },
    attachmentSlots: s.slot === 'secondary' ? ['optic', 'muzzle'] : ['optic', 'muzzle', 'magazine'],
    presentation: s.presentation,
  };
  s.overrides?.(weapon);
  return weapon;
}

const p = (
  bodyLength: number,
  barrelLength: number,
  color: string,
  soundPitch: number,
  soundLength: number,
  muzzleFlashScale = 1,
  tracerEvery = 3,
): WeaponPresentation => ({ bodyLength, bodyHeight: 0.07, barrelLength, color, soundPitch, soundLength, muzzleFlashScale, tracerEvery });

export const WEAPONS: readonly WeaponDefinition[] = [
  makeWeapon({
    id: 'ar_carbine', name: 'M4 卡賓槍', category: 'assaultRifle', slot: 'primary', modes: ['auto', 'burst', 'single'],
    rpm: 750, mag: 30, reserve: 120, reload: 2.1, emptyReload: 2.7, maxDamage: 25, minDamage: 18, falloffStart: 20, falloffEnd: 60,
    head: 1.8, hip: 3, aim: 0.15, perShot: 0.25, vKick: 0.42, hKick: 0.18, adsFov: 55, adsTime: 0.25,
    presentation: p(0.42, 0.28, '#3b3f40', 1, 0.16),
  }),
  makeWeapon({
    id: 'smg_compact', name: '緊湊衝鋒槍', category: 'smg', slot: 'primary', modes: ['auto', 'single'],
    rpm: 900, mag: 32, reserve: 160, reload: 1.9, emptyReload: 2.4, maxDamage: 22, minDamage: 12, falloffStart: 10, falloffEnd: 35,
    head: 1.6, hip: 2.2, aim: 0.3, perShot: 0.2, vKick: 0.3, hKick: 0.24, adsFov: 60, adsTime: 0.18,
    presentation: p(0.32, 0.12, '#2e3236', 1.25, 0.12),
  }),
  makeWeapon({
    id: 'dmr_marksman', name: '精準射手步槍', category: 'dmr', slot: 'primary', modes: ['single'],
    rpm: 300, mag: 20, reserve: 80, reload: 2.4, emptyReload: 3, maxDamage: 45, minDamage: 35, falloffStart: 40, falloffEnd: 100,
    head: 2, hip: 4, aim: 0.05, perShot: 0.6, vKick: 1.2, hKick: 0.3, adsFov: 40, adsTime: 0.3,
    presentation: p(0.5, 0.4, '#4a4536', 0.8, 0.22, 1.2, 1),
  }),
  makeWeapon({
    id: 'sr_bolt', name: '栓動狙擊槍', category: 'sniperRifle', slot: 'primary', modes: ['single'],
    rpm: 45, mag: 5, reserve: 25, reload: 3, emptyReload: 3.6, maxDamage: 95, minDamage: 80, falloffStart: 100, falloffEnd: 300,
    head: 2.5, hip: 6, aim: 0, perShot: 0, vKick: 3, hKick: 0.5, adsFov: 20, adsTime: 0.4,
    presentation: p(0.55, 0.55, '#3d4a3a', 0.6, 0.35, 1.4, 1),
    overrides: (w) => {
      w.damage.maxRangeMeters = 1500;
      w.recoil.firstShotMultiplier = 1;
    },
  }),
  makeWeapon({
    id: 'lmg_belt', name: '彈鏈輕機槍', category: 'lmg', slot: 'primary', modes: ['auto'],
    rpm: 650, mag: 100, reserve: 200, reload: 4.5, emptyReload: 5.5, maxDamage: 24, minDamage: 18, falloffStart: 30, falloffEnd: 80,
    head: 1.7, hip: 4, aim: 0.3, perShot: 0.2, vKick: 0.4, hKick: 0.3, adsFov: 55, adsTime: 0.35,
    presentation: p(0.55, 0.35, '#353a30', 0.9, 0.18, 1.1, 2),
    overrides: (w) => {
      w.spread.proneMultiplier = 0.35;
      w.recoil.proneMultiplier = 0.4;
      w.adsMoveMultiplier = 0.85;
    },
  }),
  makeWeapon({
    id: 'sg_pump', name: '泵動霰彈槍', category: 'shotgun', slot: 'primary', modes: ['single'],
    rpm: 70, mag: 6, reserve: 30, reload: 0.55, emptyReload: 0.55, maxDamage: 12, minDamage: 3, falloffStart: 8, falloffEnd: 25,
    head: 1.3, hip: 4, aim: 3, perShot: 0, vKick: 2.5, hKick: 0.4, adsFov: 65, adsTime: 0.25, pellets: 9, pelletSpread: 3.5, perRound: true,
    presentation: p(0.45, 0.35, '#4b3b2a', 0.55, 0.3, 1.5, 9),
  }),
  makeWeapon({
    id: 'pt_sidearm', name: '制式手槍', category: 'pistol', slot: 'secondary', modes: ['single'],
    rpm: 400, mag: 15, reserve: 45, reload: 1.5, emptyReload: 1.9, maxDamage: 24, minDamage: 14, falloffStart: 10, falloffEnd: 30,
    head: 1.7, hip: 2, aim: 0.4, perShot: 0.35, vKick: 0.7, hKick: 0.2, adsFov: 70, adsTime: 0.15,
    presentation: p(0.18, 0.04, '#26292b', 1.4, 0.12, 0.8),
  }),
];

const WEAPON_INDEX = new Map(WEAPONS.map((w) => [w.id, w]));

export function getWeapon(id: string): WeaponDefinition {
  const weapon = WEAPON_INDEX.get(id);
  if (!weapon) {
    throw new Error(`未知的武器 id：${id}`);
  }
  return weapon;
}

export function findWeapon(id: string): WeaponDefinition | undefined {
  return WEAPON_INDEX.get(id);
}

export function fireIntervalSeconds(weapon: WeaponDefinition): number {
  return 60 / Math.max(1, weapon.roundsPerMinute);
}

/** 每顆彈丸在指定距離（公尺）的傷害，尚未乘上命中部位倍率。 */
export function damageAtDistance(weapon: WeaponDefinition, meters: number): number {
  const d = weapon.damage;
  if (meters <= d.falloffStartMeters) {
    return d.maxDamage;
  }
  if (meters >= d.falloffEndMeters) {
    return d.minDamage;
  }
  const t = (meters - d.falloffStartMeters) / Math.max(1, d.falloffEndMeters - d.falloffStartMeters);
  return d.maxDamage + (d.minDamage - d.maxDamage) * t;
}
