import { useEffect, useId, useState } from 'react';
import { SETTINGS_LIMITS, applyPreset, type GameSettings, type GraphicsPreset, type QualityLevel } from '../game/core/settings';
import { ACTION_LABELS, DEFAULT_KEY_BINDINGS, INPUT_ACTIONS, formatCode, rebind, type InputAction, type KeyBindings } from '../game/input/keyBindings';

interface SettingsPanelProps {
  settings: GameSettings;
  onChange(settings: GameSettings): void;
  bindings?: KeyBindings;
  onBindingsChange?(bindings: KeyBindings): void;
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
      <input id={id} type="range" min={limits.min} max={limits.max} step={limits.step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<[T, string]>; onChange(v: T): void }) {
  const id = useId();
  return (
    <div className="setting setting--row">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="setting setting--inline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

const PERCENT = (v: number) => `${Math.round(v * 100)}%`;

/** 按鍵綁定：點選動作後按下新的按鍵或滑鼠鍵。Esc 取消。 */
function KeyBindingsEditor({ bindings, onChange }: { bindings: KeyBindings; onChange(b: KeyBindings): void }) {
  const [capturing, setCapturing] = useState<InputAction | null>(null);
  useEffect(() => {
    if (!capturing) {
      return;
    }
    const finish = (code: string) => {
      if (code !== 'Escape') {
        onChange(rebind(bindings, capturing, code));
      }
      setCapturing(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      finish(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      e.preventDefault();
      finish(`Mouse${e.button}`);
    };
    const onWheel = (e: WheelEvent) => finish(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('wheel', onWheel, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('wheel', onWheel, true);
    };
  }, [capturing, bindings, onChange]);

  return (
    <fieldset className="settings">
      <legend>按鍵</legend>
      <div className="bindings">
        {INPUT_ACTIONS.map((action) => (
          <div key={action} className="bindings__row">
            <span>{ACTION_LABELS[action]}</span>
            <button type="button" className="button button--small" aria-label={`重新綁定 ${ACTION_LABELS[action]}`} onClick={() => setCapturing(action)}>
              {capturing === action ? '請按下按鍵…' : bindings[action].map(formatCode).join(' / ')}
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="button button--small" onClick={() => onChange(DEFAULT_KEY_BINDINGS)}>
        還原預設按鍵
      </button>
    </fieldset>
  );
}

export function SettingsPanel({ settings, onChange, bindings, onBindingsChange }: SettingsPanelProps) {
  const update = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };
  const L = SETTINGS_LIMITS;
  const quality: ReadonlyArray<[QualityLevel, string]> = [
    ['off', '關閉'],
    ['low', '低'],
    ['medium', '中'],
    ['high', '高'],
  ];

  return (
    <>
      <fieldset className="settings">
        <legend>操作</legend>
        <Slider label="滑鼠靈敏度" value={settings.mouseSensitivity} display={settings.mouseSensitivity.toFixed(2)} limits={L.mouseSensitivity} onChange={(v) => update('mouseSensitivity', v)} />
        <Slider label="水平視野" value={settings.fieldOfView} display={`${settings.fieldOfView}°`} limits={L.fieldOfView} onChange={(v) => update('fieldOfView', v)} />
        <Toggle label="反轉 Y 軸" checked={settings.invertY} onChange={(v) => update('invertY', v)} />
      </fieldset>
      <fieldset className="settings">
        <legend>聲音</legend>
        <Slider label="主音量" value={settings.masterVolume} display={PERCENT(settings.masterVolume)} limits={L.volume} onChange={(v) => update('masterVolume', v)} />
        <Slider label="音效" value={settings.effectsVolume} display={PERCENT(settings.effectsVolume)} limits={L.volume} onChange={(v) => update('effectsVolume', v)} />
        <Slider label="音樂與環境音" value={settings.musicVolume} display={PERCENT(settings.musicVolume)} limits={L.volume} onChange={(v) => update('musicVolume', v)} />
      </fieldset>
      <fieldset className="settings">
        <legend>畫面</legend>
        <Select<GraphicsPreset>
          label="畫質預設"
          value={settings.graphicsPreset}
          options={[
            ['low', '低'],
            ['medium', '中'],
            ['high', '高'],
          ]}
          onChange={(v) => onChange(applyPreset(settings, v))}
        />
        <Slider label="渲染解析度" value={settings.renderScale} display={PERCENT(settings.renderScale)} limits={L.renderScale} onChange={(v) => update('renderScale', v)} />
        <Toggle label="動態解析度（畫格太慢時自動降低）" checked={settings.dynamicResolution} onChange={(v) => update('dynamicResolution', v)} />
        <Select<QualityLevel> label="陰影品質" value={settings.shadowQuality} options={quality} onChange={(v) => update('shadowQuality', v)} />
        <Select<GameSettings['foliageQuality']>
          label="植被品質"
          value={settings.foliageQuality}
          options={quality.filter(([v]) => v !== 'off') as ReadonlyArray<[GameSettings['foliageQuality'], string]>}
          onChange={(v) => update('foliageQuality', v)}
        />
        <Toggle label="後處理（暈影）" checked={settings.postProcessing} onChange={(v) => update('postProcessing', v)} />
        <Toggle label="顯示效能資訊" checked={settings.showDiagnostics} onChange={(v) => update('showDiagnostics', v)} />
      </fieldset>
      {bindings && onBindingsChange && <KeyBindingsEditor bindings={bindings} onChange={onBindingsChange} />}
    </>
  );
}
