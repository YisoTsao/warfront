import { useId } from 'react';
import { SETTINGS_LIMITS, type GameSettings } from '../game/core/settings';

interface SettingsPanelProps {
  settings: GameSettings;
  onChange(settings: GameSettings): void;
}

interface SliderProps {
  label: string;
  value: number;
  display: string;
  limits: { min: number; max: number; step: number };
  onChange(value: number): void;
}

/** 標籤以 htmlFor 指向滑桿，螢幕閱讀器與測試都能以名稱找到控制項。 */
function Slider({ label, value, display, limits, onChange }: SliderProps) {
  const id = useId();
  return (
    <div className="setting">
      <div className="setting__header">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{display}</output>
      </div>
      <input
        id={id}
        type="range"
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const update = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <fieldset className="settings">
      <legend>設定</legend>
      <Slider
        label="滑鼠靈敏度"
        value={settings.mouseSensitivity}
        display={settings.mouseSensitivity.toFixed(2)}
        limits={SETTINGS_LIMITS.mouseSensitivity}
        onChange={(v) => update('mouseSensitivity', v)}
      />
      <Slider
        label="水平視野"
        value={settings.fieldOfView}
        display={`${settings.fieldOfView}°`}
        limits={SETTINGS_LIMITS.fieldOfView}
        onChange={(v) => update('fieldOfView', v)}
      />
      <label className="setting setting--inline">
        <input type="checkbox" checked={settings.invertY} onChange={(e) => update('invertY', e.target.checked)} />
        <span>反轉 Y 軸</span>
      </label>
      <label className="setting setting--inline">
        <input
          type="checkbox"
          checked={settings.showDiagnostics}
          onChange={(e) => update('showDiagnostics', e.target.checked)}
        />
        <span>顯示效能資訊</span>
      </label>
    </fieldset>
  );
}
