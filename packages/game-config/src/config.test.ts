import { describe, expect, it } from 'vitest';
import { applyAttachments, findAttachment } from './attachments';
import { CLASSES, sanitizeLoadout } from './classes';
import { explosionDamage, getGrenade } from './equipment';
import { WEAPONS, damageAtDistance, fireIntervalSeconds, getWeapon } from './weapons';

describe('weapons', () => {
  it('每把武器的數值合理', () => {
    for (const w of WEAPONS) {
      expect(w.fireModes.length).toBeGreaterThan(0);
      expect(w.magazineSize).toBeGreaterThan(0);
      expect(w.damage.maxDamage).toBeGreaterThanOrEqual(w.damage.minDamage);
      expect(w.damage.falloffEndMeters).toBeGreaterThan(w.damage.falloffStartMeters);
      expect(w.spread.hip).toBeGreaterThanOrEqual(w.spread.aim);
    }
  });

  it('id 不重複', () => {
    expect(new Set(WEAPONS.map((w) => w.id)).size).toBe(WEAPONS.length);
  });

  it('射速換算為射擊間隔', () => {
    expect(fireIntervalSeconds(getWeapon('ar_carbine'))).toBeCloseTo(0.08);
  });

  it('傷害依距離線性衰減', () => {
    const ar = getWeapon('ar_carbine');
    expect(damageAtDistance(ar, 10)).toBe(25);
    expect(damageAtDistance(ar, 40)).toBeCloseTo(21.5);
    expect(damageAtDistance(ar, 200)).toBe(18);
  });
});

describe('attachments', () => {
  it('擴充彈匣增加彈匣容量，不相容的配件被忽略', () => {
    const ar = getWeapon('ar_carbine');
    expect(applyAttachments(ar, ['mag_extended']).magazineSize).toBe(40);
    const pistol = getWeapon('pt_sidearm');
    expect(applyAttachments(pistol, ['mag_extended']).magazineSize).toBe(pistol.magazineSize);
  });

  it('同一插槽只套用第一個配件', () => {
    const ar = getWeapon('ar_carbine');
    const result = applyAttachments(ar, ['optic_4x', 'optic_reddot']);
    expect(result.adsFov).toBe(25);
    expect(findAttachment('nope')).toBeUndefined();
  });
});

describe('classes and loadouts', () => {
  it('每個兵種引用的武器都存在', () => {
    for (const c of CLASSES) {
      for (const id of [...c.primaryOptions, ...c.secondaryOptions]) {
        expect(() => getWeapon(id)).not.toThrow();
      }
      expect(() => getGrenade(c.grenade.id)).not.toThrow();
    }
  });

  it('不合法的配裝換回預設值', () => {
    expect(sanitizeLoadout({ classId: 'medic', primaryId: 'sr_bolt' })).toMatchObject({
      classId: 'medic',
      primaryId: 'smg_compact',
      secondaryId: 'pt_sidearm',
    });
    expect(sanitizeLoadout(undefined).classId).toBe('assault');
  });
});

describe('grenades', () => {
  it('爆炸傷害依距離遞減', () => {
    const frag = getGrenade('frag');
    expect(explosionDamage(frag, 1)).toBe(120);
    expect(explosionDamage(frag, 8)).toBe(0);
    expect(explosionDamage(frag, 5.25)).toBeCloseTo(62.5);
  });
});
