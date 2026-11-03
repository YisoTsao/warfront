import { BUTTON, EDGE_BUTTONS, STANCE_CODES, type InputFrame } from '@frontline/shared';
import type { CharacterInput } from './CharacterBody';
import type { WeaponInput } from './WeaponState';

const PITCH_LIMIT = (89 * Math.PI) / 180;

/** 閒置輸入：沒有收到客戶端輸入時使用。 */
export function idleFrame(previous: InputFrame | null): InputFrame {
  return { s: previous?.s ?? 0, f: 0, r: 0, b: 0, st: previous?.st ?? 0, y: previous?.y ?? 0, p: previous?.p ?? 0, w: previous?.w ?? 0, vt: previous?.vt ?? 0 };
}

/** 重複上一個輸入（網路抖動時），但清除只在按下那一刻有效的按鈕。 */
export function repeatFrame(previous: InputFrame): InputFrame {
  return { ...previous, b: previous.b & ~EDGE_BUTTONS };
}

/**
 * 整理輸入框：軸向夾在 -1–1、pitch 夾在 ±89°、姿勢與武器欄位在合法範圍。
 * 結構已由 zod 驗證過，這裡處理數值範圍。回傳 null 表示不合法（例如 NaN）。
 */
export function sanitizeFrame(frame: InputFrame): InputFrame | null {
  const values = [frame.s, frame.f, frame.r, frame.b, frame.st, frame.y, frame.p, frame.w, frame.vt];
  if (values.some((v) => !Number.isFinite(v))) {
    return null;
  }
  return {
    s: Math.floor(frame.s),
    f: Math.max(-1, Math.min(1, Math.round(frame.f))),
    r: Math.max(-1, Math.min(1, Math.round(frame.r))),
    b: frame.b & 0x3ff,
    st: Math.max(0, Math.min(2, Math.floor(frame.st))),
    y: Math.atan2(Math.sin(frame.y), Math.cos(frame.y)),
    p: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, frame.p)),
    w: frame.w === 1 ? 1 : 0,
    vt: Math.floor(frame.vt),
  };
}

export const has = (frame: InputFrame, button: number): boolean => (frame.b & button) !== 0;

export function characterInputFrom(frame: InputFrame): CharacterInput {
  return {
    move: { forward: frame.f, right: frame.r, sprint: has(frame, BUTTON.sprint) && !has(frame, BUTTON.fire) },
    jump: has(frame, BUTTON.jump),
    stance: STANCE_CODES[frame.st] ?? 'standing',
    aim: has(frame, BUTTON.aim),
  };
}

export function weaponInputFrom(frame: InputFrame, canFire: boolean): WeaponInput {
  return {
    trigger: canFire && has(frame, BUTTON.fire),
    reload: canFire && has(frame, BUTTON.reload),
    cycleFireMode: has(frame, BUTTON.fireMode),
  };
}

/** 客戶端用：把按鍵狀態組成輸入框。 */
export function buttonsFrom(flags: Partial<Record<keyof typeof BUTTON, boolean>>): number {
  let b = 0;
  for (const [name, bit] of Object.entries(BUTTON) as Array<[keyof typeof BUTTON, number]>) {
    if (flags[name]) {
      b |= bit;
    }
  }
  return b;
}
