import type { GameSettings } from '../game/core/settings';
import { Controls } from './Controls';
import { SettingsPanel } from './SettingsPanel';

interface MenuOverlayProps {
  /** 第一次進入顯示「點擊開始」，之後顯示暫停選單 */
  mode: 'start' | 'paused';
  settings: GameSettings;
  lockError: string | null;
  onPlay(): void;
  onSettingsChange(settings: GameSettings): void;
}

export function MenuOverlay({ mode, settings, lockError, onPlay, onSettingsChange }: MenuOverlayProps) {
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
        <p className="subtitle">{mode === 'start' ? '灰盒移動測試' : '已暫停'}</p>
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
        <Controls />
        <SettingsPanel settings={settings} onChange={onSettingsChange} />
      </div>
    </div>
  );
}
