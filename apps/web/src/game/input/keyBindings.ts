/** 可綁定的動作。新增動作只要加在這裡與預設綁定，不寫死在控制器裡。 */
export const INPUT_ACTIONS = [
  'moveForward',
  'moveBackward',
  'moveLeft',
  'moveRight',
  'sprint',
  'jump',
  'crouch',
  'prone',
  'fire',
  'aim',
  'reload',
  'primaryWeapon',
  'secondaryWeapon',
  'nextWeapon',
  'previousWeapon',
  'fireMode',
  'grenade',
  'ability',
  'interact',
  'giveUp',
  'scoreboard',
  'tacticalMap',
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];

/** 每個動作對應一或多個輸入碼：KeyboardEvent.code、Mouse0/1/2、WheelUp/WheelDown。 */
export type KeyBindings = Record<InputAction, readonly string[]>;

export const ACTION_LABELS: Record<InputAction, string> = {
  moveForward: '前進',
  moveBackward: '後退',
  moveLeft: '左移',
  moveRight: '右移',
  sprint: '衝刺（按住）',
  jump: '跳躍／起身',
  crouch: '蹲下',
  prone: '臥倒',
  fire: '開火',
  aim: '瞄準（ADS）',
  reload: '換彈',
  primaryWeapon: '主武器',
  secondaryWeapon: '副武器',
  nextWeapon: '下一把武器',
  previousWeapon: '上一把武器',
  fireMode: '切換射擊模式',
  grenade: '投擲手榴彈',
  ability: '兵種技能',
  interact: '救援（按住）',
  giveUp: '倒地時放棄（按住）',
  scoreboard: '計分板（按住）',
  tacticalMap: '戰術地圖（按住）',
};

/**
 * 預設按鍵。蹲下刻意不用 Ctrl：瀏覽器在非全螢幕的 Pointer Lock 下無法攔截 Ctrl+W，
 * 玩家邊蹲邊往前走會直接關閉分頁。
 */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBackward: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  jump: ['Space'],
  crouch: ['KeyC'],
  prone: ['KeyZ'],
  fire: ['Mouse0'],
  aim: ['Mouse2'],
  reload: ['KeyR'],
  primaryWeapon: ['Digit1'],
  secondaryWeapon: ['Digit2'],
  nextWeapon: ['WheelDown'],
  previousWeapon: ['WheelUp'],
  fireMode: ['KeyB'],
  grenade: ['KeyG'],
  ability: ['KeyQ'],
  interact: ['KeyE'],
  giveUp: ['KeyX'],
  scoreboard: ['Tab'],
  tacticalMap: ['KeyM'],
};

/** 不允許綁定的輸入碼（瀏覽器或系統保留） */
export const RESERVED_CODES: ReadonlySet<string> = new Set(['Escape', 'MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'F5', 'F11', 'F12']);

/** 建立 輸入碼 → 動作 的查表；同一個碼綁到多個動作時以後者為準。 */
export function buildCodeLookup(bindings: KeyBindings): Map<string, InputAction> {
  const lookup = new Map<string, InputAction>();
  for (const action of INPUT_ACTIONS) {
    for (const code of bindings[action]) {
      lookup.set(code, action);
    }
  }
  return lookup;
}

/** 把某個輸入碼綁到動作（取代該動作原本的第一個綁定），並從其他動作移除這個碼。 */
export function rebind(bindings: KeyBindings, action: InputAction, code: string): KeyBindings {
  if (RESERVED_CODES.has(code)) {
    return bindings;
  }
  const next = { ...bindings } as Record<InputAction, readonly string[]>;
  for (const other of INPUT_ACTIONS) {
    next[other] = next[other].filter((c) => c !== code);
  }
  next[action] = [code, ...bindings[action].slice(1).filter((c) => c !== code)];
  return next;
}

/** 從儲存的資料還原綁定；缺少或格式錯誤的動作使用預設值。 */
export function sanitizeBindings(input: unknown): KeyBindings {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const result = { ...DEFAULT_KEY_BINDINGS } as Record<InputAction, readonly string[]>;
  for (const action of INPUT_ACTIONS) {
    const value = raw[action];
    if (Array.isArray(value) && value.every((v) => typeof v === 'string' && !RESERVED_CODES.has(v)) && value.length > 0) {
      result[action] = value.slice(0, 3) as string[];
    }
  }
  return result;
}

export function formatCode(code: string): string {
  if (code.startsWith('Key')) {
    return code.slice(3);
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  const names: Record<string, string> = {
    Mouse0: '滑鼠左鍵',
    Mouse1: '滑鼠中鍵',
    Mouse2: '滑鼠右鍵',
    WheelUp: '滾輪上',
    WheelDown: '滾輪下',
    Space: '空白鍵',
    ShiftLeft: '左 Shift',
    ShiftRight: '右 Shift',
    Tab: 'Tab',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    AltLeft: '左 Alt',
  };
  return names[code] ?? code;
}

/** 由兩個相反方向的按鍵狀態算出 -1、0 或 1 的軸向值。 */
export function axis(positive: boolean, negative: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}
