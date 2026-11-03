/** 玩家設定。只存放本機偏好，不影響任何權威遊戲狀態。 */
export interface GameSettings {
  /** 滑鼠靈敏度倍率，1 = 每像素 0.0022 弧度 */
  mouseSensitivity: number;
  invertY: boolean;
  /** 水平視野（度），與多數 PC 射擊遊戲的設定方式相同 */
  fieldOfView: number;
  showDiagnostics: boolean;
}

export const SETTINGS_LIMITS = {
  mouseSensitivity: { min: 0.1, max: 5, step: 0.05 },
  fieldOfView: { min: 70, max: 110, step: 1 },
} as const;

export const DEFAULT_SETTINGS: GameSettings = {
  mouseSensitivity: 1,
  invertY: false,
  fieldOfView: 90,
  showDiagnostics: true,
};

const STORAGE_KEY = 'frontline.settings.v1';

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** 把任何來源（localStorage、UI）的值整理成合法設定。 */
export function sanitizeSettings(input: unknown): GameSettings {
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return {
    mouseSensitivity: clampNumber(
      raw.mouseSensitivity,
      SETTINGS_LIMITS.mouseSensitivity.min,
      SETTINGS_LIMITS.mouseSensitivity.max,
      DEFAULT_SETTINGS.mouseSensitivity,
    ),
    invertY: typeof raw.invertY === 'boolean' ? raw.invertY : DEFAULT_SETTINGS.invertY,
    fieldOfView: clampNumber(
      raw.fieldOfView,
      SETTINGS_LIMITS.fieldOfView.min,
      SETTINGS_LIMITS.fieldOfView.max,
      DEFAULT_SETTINGS.fieldOfView,
    ),
    showDiagnostics:
      typeof raw.showDiagnostics === 'boolean' ? raw.showDiagnostics : DEFAULT_SETTINGS.showDiagnostics,
  };
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
