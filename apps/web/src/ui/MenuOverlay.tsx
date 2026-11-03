import type { GameSettings } from '../game/core/settings';
import type { KeyBindings } from '../game/input/keyBindings';
import { Controls } from './Controls';
import { SettingsPanel } from './SettingsPanel';

interface MenuOverlayProps {
  /** 第一次進入顯示「點擊開始」，之後顯示暫停選單 */
  mode: 'start' | 'paused';
  title?: string;
  settings: GameSettings;
  bindings: KeyBindings;
  lockError: string | null;
  onPlay(): void;
  onSettingsChange(settings: GameSettings): void;
  onBindingsChange(bindings: KeyBindings): void;
  onLeave?: () => void;
  leaveLabel?: string;
  children?: React.ReactNode;
}

export function MenuOverlay({ mode, title, settings, bindings, lockError, onPlay, onSettingsChange, onBindingsChange, onLeave, leaveLabel, children }: MenuOverlayProps) {
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  };

  return (
    <div className="overlay">
      <div className="panel">
        <h1 className="title">FRONTLINE</h1>
        <p className="subtitle">{title ?? (mode === 'start' ? '訓練場' : '已暫停')}</p>
        {children}
        <button type="button" className="button button--primary" onClick={onPlay} autoFocus>
          {mode === 'start' ? '點擊開始' : '繼續遊戲'}
        </button>
        {lockError && (
          <p className="error" role="alert">
            {lockError}
          </p>
        )}
        <button type="button" className="button" onClick={toggleFullscreen}>
          切換全螢幕
        </button>
        {onLeave && (
          <button type="button" className="button" onClick={onLeave}>
            {leaveLabel ?? '返回主選單'}
          </button>
        )}
        <Controls bindings={bindings} />
        <SettingsPanel settings={settings} onChange={onSettingsChange} bindings={bindings} onBindingsChange={onBindingsChange} />
      </div>
    </div>
  );
}
