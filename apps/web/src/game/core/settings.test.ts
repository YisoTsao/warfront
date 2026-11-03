import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  it('無效輸入回到預設值', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ mouseSensitivity: 'fast', fieldOfView: Number.NaN })).toEqual(DEFAULT_SETTINGS);
  });

  it('超出範圍的數值會被夾住', () => {
    const s = sanitizeSettings({ mouseSensitivity: 99, fieldOfView: 10 });
    expect(s.mouseSensitivity).toBe(SETTINGS_LIMITS.mouseSensitivity.max);
    expect(s.fieldOfView).toBe(SETTINGS_LIMITS.fieldOfView.min);
  });

  it('保留合法值', () => {
    const s = sanitizeSettings({ mouseSensitivity: 1.5, invertY: true, fieldOfView: 100, showDiagnostics: false });
    expect(s).toEqual({ mouseSensitivity: 1.5, invertY: true, fieldOfView: 100, showDiagnostics: false });
  });
});
