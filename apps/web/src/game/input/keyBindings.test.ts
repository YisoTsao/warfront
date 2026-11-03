import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_BINDINGS, axis, buildCodeLookup, formatCode, rebind, sanitizeBindings } from './keyBindings';

describe('buildCodeLookup', () => {
  it('每個預設按鍵都對應到動作', () => {
    const lookup = buildCodeLookup(DEFAULT_KEY_BINDINGS);
    expect(lookup.get('KeyW')).toBe('moveForward');
    expect(lookup.get('Space')).toBe('jump');
    expect(lookup.get('KeyC')).toBe('crouch');
    expect(lookup.get('KeyZ')).toBe('prone');
    expect(lookup.get('Mouse0')).toBe('fire');
    expect(lookup.get('WheelDown')).toBe('nextWeapon');
  });

  it('預設不綁 Ctrl，避免 Ctrl+W 關閉分頁', () => {
    const lookup = buildCodeLookup(DEFAULT_KEY_BINDINGS);
    expect(lookup.has('ControlLeft')).toBe(false);
  });
});

describe('rebind', () => {
  it('新按鍵取代原綁定，並從其他動作移除', () => {
    const next = rebind(DEFAULT_KEY_BINDINGS, 'crouch', 'KeyW');
    expect(next.crouch[0]).toBe('KeyW');
    expect(next.moveForward).toEqual(['ArrowUp']);
  });

  it('保留鍵不能綁定', () => {
    expect(rebind(DEFAULT_KEY_BINDINGS, 'jump', 'Escape')).toBe(DEFAULT_KEY_BINDINGS);
  });
});

describe('sanitizeBindings', () => {
  it('格式錯誤或含保留鍵時使用預設值', () => {
    const result = sanitizeBindings({ jump: ['KeyF'], crouch: 'C', prone: ['ControlLeft'] });
    expect(result.jump).toEqual(['KeyF']);
    expect(result.crouch).toEqual(DEFAULT_KEY_BINDINGS.crouch);
    expect(result.prone).toEqual(DEFAULT_KEY_BINDINGS.prone);
  });
});

describe('axis / formatCode', () => {
  it('相反方向同時按住時互相抵銷', () => {
    expect(axis(true, false)).toBe(1);
    expect(axis(true, true)).toBe(0);
  });

  it('顯示易讀的按鍵名稱', () => {
    expect(formatCode('KeyW')).toBe('W');
    expect(formatCode('Digit1')).toBe('1');
    expect(formatCode('Mouse2')).toBe('滑鼠右鍵');
  });
});
