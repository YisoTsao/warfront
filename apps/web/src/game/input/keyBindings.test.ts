import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_BINDINGS, axis, buildCodeLookup } from './keyBindings';

describe('buildCodeLookup', () => {
  it('每個預設按鍵都對應到動作', () => {
    const lookup = buildCodeLookup(DEFAULT_KEY_BINDINGS);
    expect(lookup.get('KeyW')).toBe('moveForward');
    expect(lookup.get('ArrowUp')).toBe('moveForward');
    expect(lookup.get('Space')).toBe('jump');
    expect(lookup.get('KeyC')).toBe('crouch');
  });

  it('預設不綁 Ctrl，避免 Ctrl+W 關閉分頁', () => {
    const lookup = buildCodeLookup(DEFAULT_KEY_BINDINGS);
    expect(lookup.has('ControlLeft')).toBe(false);
    expect(lookup.has('ControlRight')).toBe(false);
  });
});

describe('axis', () => {
  it('相反方向同時按住時互相抵銷', () => {
    expect(axis(true, false)).toBe(1);
    expect(axis(false, true)).toBe(-1);
    expect(axis(true, true)).toBe(0);
    expect(axis(false, false)).toBe(0);
  });
});
