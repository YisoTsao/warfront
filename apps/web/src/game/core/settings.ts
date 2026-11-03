/** 玩家設定。只存放本機偏好，不影響任何權威遊戲狀態。 */
export type GraphicsPreset = 'low' | 'medium' | 'high';
export type QualityLevel = 'off' | 'low' | 'medium' | 'high';

export interface GameSettings {
  /** 滑鼠靈敏度倍率，1 = 每像素 0.0022 弧度 */
  mouseSensitivity: number;
  invertY: boolean;
  /** 水平視野（度），與多數 PC 射擊遊戲的設定方式相同 */
  fieldOfView: number;
  showDiagnostics: boolean;
  masterVolume: number;
  effectsVolume: number;
  musicVolume: number;
  graphicsPreset: GraphicsPreset;
  /** 渲染解析度倍率 */
  renderScale: number;
  /** 依畫格時間自動降低解析度 */
  dynamicResolution: boolean;
  shadowQuality: QualityLevel;
  foliageQuality: Exclude<QualityLevel, 'off'>;
  postProcessing: boolean;
}

export const SETTINGS_LIMITS = {
  mouseSensitivity: { min: 0.1, max: 5, step: 0.05 },
  fieldOfView: { min: 70, max: 110, step: 1 },
  volume: { min: 0, max: 1, step: 0.05 },
  renderScale: { min: 0.5, max: 1, step: 0.05 },
} as const;

export const GRAPHICS_PRESETS: Record<GraphicsPreset, Pick<GameSettings, 'renderScale' | 'shadowQuality' | 'foliageQuality' | 'postProcessing' | 'dynamicResolution'>> = {
  low: { renderScale: 0.7, shadowQuality: 'off', foliageQuality: 'low', postProcessing: false, dynamicResolution: true },
  medium: { renderScale: 0.85, shadowQuality: 'medium', foliageQuality: 'medium', postProcessing: false, dynamicResolution: true },
  high: { renderScale: 1, shadowQuality: 'high', foliageQuality: 'high', postProcessing: true, dynamicResolution: true },
};

export const DEFAULT_SETTINGS: GameSettings = {
  mouseSensitivity: 1,
  invertY: false,
  fieldOfView: 90,
  showDiagnostics: true,
  masterVolume: 0.8,
  effectsVolume: 1,
  musicVolume: 0.5,
  graphicsPreset: 'medium',
  ...GRAPHICS_PRESETS.medium,
};

const STORAGE_KEY = 'frontline.settings.v1';
const QUALITY: readonly QualityLevel[] = ['off', 'low', 'medium', 'high'];

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把任何來源（localStorage、UI）的值整理成合法設定。 */
export function sanitizeSettings(input: unknown): GameSettings {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const L = SETTINGS_LIMITS;
  return {
    mouseSensitivity: clampNumber(raw.mouseSensitivity, L.mouseSensitivity.min, L.mouseSensitivity.max, d.mouseSensitivity),
    invertY: bool(raw.invertY, d.invertY),
    fieldOfView: clampNumber(raw.fieldOfView, L.fieldOfView.min, L.fieldOfView.max, d.fieldOfView),
    showDiagnostics: bool(raw.showDiagnostics, d.showDiagnostics),
    masterVolume: clampNumber(raw.masterVolume, 0, 1, d.masterVolume),
    effectsVolume: clampNumber(raw.effectsVolume, 0, 1, d.effectsVolume),
    musicVolume: clampNumber(raw.musicVolume, 0, 1, d.musicVolume),
    graphicsPreset: pick(raw.graphicsPreset, ['low', 'medium', 'high'] as const, d.graphicsPreset),
    renderScale: clampNumber(raw.renderScale, L.renderScale.min, L.renderScale.max, d.renderScale),
    dynamicResolution: bool(raw.dynamicResolution, d.dynamicResolution),
    shadowQuality: pick(raw.shadowQuality, QUALITY, d.shadowQuality),
    foliageQuality: pick(raw.foliageQuality, ['low', 'medium', 'high'] as const, d.foliageQuality),
    postProcessing: bool(raw.postProcessing, d.postProcessing),
  };
}

/** 套用畫質預設：覆寫細項設定。 */
export function applyPreset(settings: GameSettings, preset: GraphicsPreset): GameSettings {
  return { ...settings, graphicsPreset: preset, ...GRAPHICS_PRESETS[preset] };
}

export function loadSettings(): GameSettings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(stored ? JSON.parse(stored) : null);
  } catch {
    // 無痕模式或儲存被封鎖時使用預設值。
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 無法儲存時只在本次遊玩生效。
  }
}

const BINDINGS_KEY = 'frontline.bindings.v1';

export function loadStoredBindings(): unknown {
  try {
    const stored = window.localStorage.getItem(BINDINGS_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function saveBindings(bindings: unknown): void {
  try {
    window.localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
  } catch {
    // 忽略
  }
}
