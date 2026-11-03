import { useCallback, useEffect, useRef, useState } from 'react';
import type { Loadout } from '@frontline/game-config';
import type { Game } from '../game/core/Game';
import { saveSettings, type GameSettings } from '../game/core/settings';
import type { KeyBindings } from '../game/input/keyBindings';
import type { MapLoadProgress } from '../game/world/MapRuntime';
import { Hud } from '../ui/Hud';
import { MenuOverlay } from '../ui/MenuOverlay';

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

interface TrainingViewProps {
  mapId: string;
  loadout: Partial<Loadout>;
  settings: GameSettings;
  bindings: KeyBindings;
  onSettingsChange(settings: GameSettings): void;
  onBindingsChange(bindings: KeyBindings): void;
  onLeave?: () => void;
}

/** 訓練場（單機）：掛載 Three.js 畫布與遊戲迴圈。React state 只在生命週期事件時改變。 */
export function TrainingView({ mapId, loadout, settings, bindings, onSettingsChange, onBindingsChange, onLeave }: TrainingViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const debugRef = useRef<HTMLPreElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  const initial = useRef({ settings, bindings, loadout });
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [locked, setLocked] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [progress, setProgress] = useState<MapLoadProgress | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    let created: Game | null = null;
    // 遊戲本體（Three.js、Rapier WASM）延後載入，選單外殼可以先顯示。
    import('../game/core/Game')
      .then(({ Game }) =>
        Game.create(container, {
          mapId,
          settings: initial.current.settings,
          bindings: initial.current.bindings,
          loadout: initial.current.loadout,
          callbacks: {
            onPointerLockChange: (isLocked) => {
              setLocked(isLocked);
              if (isLocked) {
                setHasStarted(true);
                setLockError(null);
              }
            },
            onContextLostChange: setContextLost,
            onLoadProgress: setProgress,
          },
        }),
      )
      .then((instance) => {
        if (cancelled) {
          instance.dispose();
          return;
        }
        created = instance;
        instance.attachDebugOutput(debugRef.current);
        instance.start();
        setGame(instance);
        setLoad({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, [mapId]);

  useEffect(() => {
    game?.applySettings(settings);
    saveSettings(settings);
  }, [game, settings]);

  useEffect(() => {
    game?.setBindings(bindings);
  }, [game, bindings]);

  const play = useCallback(() => {
    game?.requestPointerLock().catch(() => {
      // Chrome 在按 Esc 離開後約一秒內會拒絕重新鎖定。
      setLockError('瀏覽器暫時拒絕鎖定滑鼠，請稍候一秒再按一次。');
    });
  }, [game]);

  const crosshairRef = useCallback((el: HTMLDivElement | null) => game?.attachCrosshair(el), [game]);

  return (
    <div className="game-root">
      <div ref={containerRef} className="game-container" />
      <pre ref={debugRef} className="diagnostics" hidden={!settings.showDiagnostics} aria-label="效能資訊" />
      {game && <Hud store={game.hud} crosshairRef={crosshairRef} />}
      {load.status === 'loading' && (
        <div className="overlay overlay--solid">
          <p className="subtitle" role="status">
            {progress?.stage === 'chunks' ? `載入地圖分塊 ${progress.done} / ${progress.total}` : '載入中…'}
          </p>
        </div>
      )}
      {load.status === 'error' && (
        <div className="overlay overlay--solid" role="alert">
          <div className="panel">
            <h1 className="title">啟動失敗</h1>
            <p className="error">{load.message}</p>
            {onLeave && (
              <button type="button" className="button" onClick={onLeave}>
                返回主選單
              </button>
            )}
          </div>
        </div>
      )}
      {load.status === 'ready' && !locked && (
        <MenuOverlay
          mode={hasStarted ? 'paused' : 'start'}
          settings={settings}
          bindings={bindings}
          lockError={lockError}
          onPlay={play}
          onSettingsChange={onSettingsChange}
          onBindingsChange={onBindingsChange}
          {...(onLeave ? { onLeave } : {})}
        />
      )}
      {contextLost && (
        <div className="banner" role="alert">
          繪圖內容遺失，正在等待瀏覽器恢復…
        </div>
      )}
    </div>
  );
}
