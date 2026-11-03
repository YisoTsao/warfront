import { useCallback, useEffect, useRef, useState } from 'react';
import type { Game } from '../game/core/Game';
import type { MapLoadProgress } from '../game/world/MapRuntime';
import { saveSettings, type GameSettings } from '../game/core/settings';
import { MenuOverlay } from '../ui/MenuOverlay';

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

interface GameViewProps {
  mapId: string;
  settings: GameSettings;
  onSettingsChange(settings: GameSettings): void;
}

/** 掛載 Three.js 畫布與遊戲迴圈。React state 只在生命週期事件（載入、鎖定、暫停）時改變。 */
export function GameView({ mapId, settings, onSettingsChange }: GameViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const debugRef = useRef<HTMLPreElement>(null);
  const gameRef = useRef<Game | null>(null);
  const initialSettings = useRef(settings);
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
    let game: Game | null = null;
    // 遊戲本體（Three.js、Rapier WASM）延後載入，選單外殼可以先顯示。
    import('../game/core/Game')
      .then(({ Game }) =>
        Game.create(container, {
          mapId,
          settings: initialSettings.current,
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
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        game = created;
        gameRef.current = created;
        created.attachDebugOutput(debugRef.current);
        created.start();
        setLoad({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
      game?.dispose();
      gameRef.current = null;
    };
  }, [mapId]);

  useEffect(() => {
    gameRef.current?.applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  const play = useCallback(() => {
    const game = gameRef.current;
    if (!game) {
      return;
    }
    game.requestPointerLock().catch(() => {
      // Chrome 在按 Esc 離開後約一秒內會拒絕重新鎖定。
      setLockError('瀏覽器暫時拒絕鎖定滑鼠，請稍候一秒再按一次。');
    });
  }, []);

  return (
    <div className="game-root">
      <div ref={containerRef} className="game-container" />
      <pre ref={debugRef} className="diagnostics" hidden={!settings.showDiagnostics} aria-label="效能資訊" />
      {locked && <div className="crosshair" aria-hidden="true" />}
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
          </div>
        </div>
      )}
      {load.status === 'ready' && !locked && (
        <MenuOverlay
          mode={hasStarted ? 'paused' : 'start'}
          settings={settings}
          lockError={lockError}
          onPlay={play}
          onSettingsChange={onSettingsChange}
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
