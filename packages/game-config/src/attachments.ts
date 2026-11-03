import type { AttachmentSlot, WeaponCategory, WeaponDefinition } from './weapons';

/** 配件只改變數值，套用後得到新的武器定義。 */
export interface AttachmentDefinition {
  id: string;
  displayName: string;
  slot: AttachmentSlot;
  compatible: readonly WeaponCategory[];
  apply(weapon: WeaponDefinition): WeaponDefinition;
}

const ALL: readonly WeaponCategory[] = ['assaultRifle', 'smg', 'dmr', 'sniperRifle', 'lmg', 'shotgun', 'pistol'];
const LONG_GUNS: readonly WeaponCategory[] = ['assaultRifle', 'smg', 'dmr', 'lmg'];

export const ATTACHMENTS: readonly AttachmentDefinition[] = [
  {
    id: 'optic_reddot',
    displayName: '內紅點',
    slot: 'optic',
    compatible: ALL,
    apply: (w) => ({ ...w, adsSeconds: w.adsSeconds * 0.9, spread: { ...w.spread, aim: w.spread.aim * 0.9 } }),
  },
  {
    id: 'optic_4x',
    displayName: '4 倍鏡',
    slot: 'optic',
    compatible: ['assaultRifle', 'dmr', 'lmg', 'sniperRifle'],
    apply: (w) => ({ ...w, adsFov: Math.min(w.adsFov, 25), adsSeconds: w.adsSeconds * 1.2 }),
  },
  {
    id: 'muzzle_suppressor',
    displayName: '滅音器',
    slot: 'muzzle',
    compatible: ALL.filter((c) => c !== 'shotgun'),
    apply: (w) => ({
      ...w,
      damage: { ...w.damage, falloffEndMeters: w.damage.falloffEndMeters * 0.85 },
      presentation: { ...w.presentation, muzzleFlashScale: 0.2, soundPitch: w.presentation.soundPitch * 1.6 },
    }),
  },
  {
    id: 'muzzle_compensator',
    displayName: '制退器',
    slot: 'muzzle',
    compatible: LONG_GUNS,
    apply: (w) => ({ ...w, recoil: { ...w.recoil, verticalKick: w.recoil.verticalKick * 0.8 } }),
  },
  {
    id: 'mag_extended',
    displayName: '擴充彈匣',
    slot: 'magazine',
    compatible: LONG_GUNS,
    apply: (w) => ({
      ...w,
      magazineSize: Math.round(w.magazineSize * 1.33),
      reloadSeconds: w.reloadSeconds * 1.1,
      emptyReloadSeconds: w.emptyReloadSeconds * 1.1,
    }),
  },
];

const ATTACHMENT_INDEX = new Map(ATTACHMENTS.map((a) => [a.id, a]));

export function findAttachment(id: string): AttachmentDefinition | undefined {
  return ATTACHMENT_INDEX.get(id);
}

/** 套用配件；不相容、重複插槽或未知的配件會被忽略。 */
export function applyAttachments(weapon: WeaponDefinition, attachmentIds: readonly string[]): WeaponDefinition {
  const used = new Set<AttachmentSlot>();
  let result = weapon;
  for (const id of attachmentIds) {
    const attachment = ATTACHMENT_INDEX.get(id);
    if (
      !attachment ||
      used.has(attachment.slot) ||
      !weapon.attachmentSlots.includes(attachment.slot) ||
      !attachment.compatible.includes(weapon.category)
    ) {
      continue;
    }
    used.add(attachment.slot);
    result = attachment.apply(result);
  }
  return result;
}
