/** 可綁定的動作。之後的武器、互動等動作也加在這裡，不寫死在控制器裡。 */
export type InputAction =
  | 'moveForward'
  | 'moveBackward'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'jump'
  | 'crouch';

/** 每個動作對應一或多個 KeyboardEvent.code（與鍵盤配置語系無關）。 */
export type KeyBindings = Record<InputAction, readonly string[]>;

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
};

/** 建立 code → 動作 的查表；同一個 code 綁到多個動作時以後者為準。 */
export function buildCodeLookup(bindings: KeyBindings): Map<string, InputAction> {
  const lookup = new Map<string, InputAction>();
  for (const action of Object.keys(bindings) as InputAction[]) {
    for (const code of bindings[action]) {
      lookup.set(code, action);
    }
  }
  return lookup;
}

/** 由兩個相反方向的按鍵狀態算出 -1、0 或 1 的軸向值。 */
export function axis(positive: boolean, negative: boolean): number {
  return (positive ? 1 : 0) - (negative ? 1 : 0);
}
