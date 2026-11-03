/** 兵種技能。效果由伺服器執行，這裡只描述參數。 */
export type AbilityDefinition =
  | { kind: 'stim'; displayName: string; cooldownSeconds: number; healAmount: number }
  | { kind: 'healPulse'; displayName: string; cooldownSeconds: number; radius: number; healAmount: number }
  | { kind: 'resupply'; displayName: string; cooldownSeconds: number; radius: number }
  | { kind: 'spot'; displayName: string; cooldownSeconds: number; range: number; coneHalfAngleDegrees: number; durationSeconds: number };

export interface ClassDefinition {
  id: string;
  displayName: string;
  description: string;
  maxHealth: number;
  sprintMultiplier: number;
  /** 救援倒地隊友所需秒數 */
  reviveSeconds: number;
  /** 被救起時恢復的血量比例 */
  reviveHealthFraction: number;
  primaryOptions: readonly string[];
  secondaryOptions: readonly string[];
  grenade: { id: string; count: number };
  ability: AbilityDefinition;
}

/** 四個兵種。數值來源：舊版 UE5 FLDefaultContent.cpp 與 FLAbility.h（公分已換算為公尺）。 */
export const CLASSES: readonly ClassDefinition[] = [
  {
    id: 'assault',
    displayName: '突擊兵',
    description: '前線步槍兵，多一顆手榴彈，可以施打興奮劑回血。',
    maxHealth: 100,
    sprintMultiplier: 1,
    reviveSeconds: 5,
    reviveHealthFraction: 0.3,
    primaryOptions: ['ar_carbine', 'sg_pump'],
    secondaryOptions: ['pt_sidearm'],
    grenade: { id: 'frag', count: 2 },
    ability: { kind: 'stim', displayName: '戰鬥興奮劑', cooldownSeconds: 20, healAmount: 50 },
  },
  {
    id: 'medic',
    displayName: '醫療兵',
    description: '救援快且救起後滿血，治療脈衝可以替附近隊友回血。',
    maxHealth: 100,
    sprintMultiplier: 1,
    reviveSeconds: 2,
    reviveHealthFraction: 1,
    primaryOptions: ['smg_compact', 'sg_pump'],
    secondaryOptions: ['pt_sidearm'],
    grenade: { id: 'frag', count: 1 },
    ability: { kind: 'healPulse', displayName: '治療脈衝', cooldownSeconds: 20, radius: 8, healAmount: 40 },
  },
  {
    id: 'support',
    displayName: '支援兵',
    description: '壓制火力，替附近隊友補滿彈藥與手榴彈。',
    maxHealth: 100,
    sprintMultiplier: 1,
    reviveSeconds: 5,
    reviveHealthFraction: 0.3,
    primaryOptions: ['lmg_belt', 'ar_carbine'],
    secondaryOptions: ['pt_sidearm'],
    grenade: { id: 'frag', count: 1 },
    ability: { kind: 'resupply', displayName: '彈藥補給', cooldownSeconds: 25, radius: 8 },
  },
  {
    id: 'recon',
    displayName: '偵察兵',
    description: '遠距離射手，可以標定前方敵人讓全隊看見。',
    maxHealth: 100,
    sprintMultiplier: 1,
    reviveSeconds: 5,
    reviveHealthFraction: 0.3,
    primaryOptions: ['sr_bolt', 'dmr_marksman'],
    secondaryOptions: ['pt_sidearm'],
    grenade: { id: 'frag', count: 1 },
    ability: { kind: 'spot', displayName: '標定', cooldownSeconds: 15, range: 200, coneHalfAngleDegrees: 12, durationSeconds: 8 },
  },
];

/** 規格 §7：第一場可玩對戰先用單一預設步兵配裝。 */
export const DEFAULT_CLASS_ID = 'assault';

export function getClass(id: string): ClassDefinition {
  const found = CLASSES.find((c) => c.id === id);
  if (!found) {
    throw new Error(`未知的兵種 id：${id}`);
  }
  return found;
}

export function findClass(id: string): ClassDefinition | undefined {
  return CLASSES.find((c) => c.id === id);
}

export interface Loadout {
  classId: string;
  primaryId: string;
  secondaryId: string;
  attachments: Record<string, readonly string[]>;
}

/** 檢查並修正玩家送來的配裝：不合法的選項換回該兵種的預設值。 */
export function sanitizeLoadout(input: Partial<Loadout> | undefined): Loadout {
  const cls = findClass(input?.classId ?? '') ?? getClass(DEFAULT_CLASS_ID);
  const primaryId = cls.primaryOptions.includes(input?.primaryId ?? '') ? input!.primaryId! : cls.primaryOptions[0]!;
  const secondaryId = cls.secondaryOptions.includes(input?.secondaryId ?? '') ? input!.secondaryId! : cls.secondaryOptions[0]!;
  const attachments: Record<string, readonly string[]> = {};
  for (const weaponId of [primaryId, secondaryId]) {
    const list = input?.attachments?.[weaponId];
    if (Array.isArray(list)) {
      attachments[weaponId] = list.filter((v): v is string => typeof v === 'string').slice(0, 3);
    }
  }
  return { classId: cls.id, primaryId, secondaryId, attachments };
}
