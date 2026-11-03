import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, GRAPHICS_PRESETS, SETTINGS_LIMITS, applyPreset, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  it('無效輸入回到預設值', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ mouseSensitivity: 'fast', fieldOfView: Number.NaN, shadowQuality: 'ultra' })).toEqual(DEFAULT_SETTINGS);
  });

  it('超出範圍的數值會被夾住', () => {
    const s = sanitizeSettings({ mouseSensitivity: 99, fieldOfView: 10, masterVolume: 2, renderScale: 0.1 });
    expect(s.mouseSensitivity).toBe(SETTINGS_LIMITS.mouseSensitivity.max);
    expect(s.fieldOfView).toBe(SETTINGS_LIMITS.fieldOfView.min);
    expect(s.masterVolume).toBe(1);
    expect(s.renderScale).toBe(SETTINGS_LIMITS.renderScale.min);
  });

  it('保留合法值', () => {
    const s = sanitizeSettings({ mouseSensitivity: 1.5, invertY: true, fieldOfView: 100, showDiagnostics: false, shadowQuality: 'off' });
    expect(s).toMatchObject({ mouseSensitivity: 1.5, invertY: true, fieldOfView: 100, showDiagnostics: false, shadowQuality: 'off' });
  });
});

describe('applyPreset', () => {
  it('套用預設會覆寫細項', () => {
    const s = applyPreset(DEFAULT_SETTINGS, 'low');
    expect(s.graphicsPreset).toBe('low');
    expect(s.shadowQuality).toBe(GRAPHICS_PRESETS.low.shadowQuality);
    expect(s.renderScale).toBe(GRAPHICS_PRESETS.low.renderScale);
  });
});
