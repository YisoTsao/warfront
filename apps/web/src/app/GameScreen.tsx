import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { GameBase, GameCallbacks } from '../game/core/GameBase';
import { saveSettings, type GameSettings } from '../game/core/settings';
import { useHud } from '../game/hud/HudStore';
import type { KeyBindings } from '../game/input/keyBindings';
import type { MapLoadProgress } from '../game/world/MapRuntime';
import { Hud } from '../ui/Hud';
import { MenuOverlay } from '../ui/MenuOverlay';

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string };

export interface GameScreenProps<G extends GameBase> {
  /** 建立遊戲（只在 key 改變時重新建立） */
  create(container: HTMLElement, callbacks: GameCallbacks): Promise<G>;
  createKey: string;
  settings: GameSettings;
  bindings: KeyBindings;
  onSettingsChange(settings: GameSettings): void;
  onBindingsChange(bindings: KeyBindings): void;
  onLeave(): void;
  title: string;
  loadingText?: string;
  /** 自訂「未鎖定滑鼠」時要顯示的畫面（例如部署畫面）；回傳 null 則使用預設暫停選單 */
  renderUnlocked?(game: G, play: () => void, lockError: string | null): ReactNode | null;
  onReady?(game: G): void;
}

/** 單機與連線共用的遊戲畫面：畫布、HUD、小地圖、戰術地圖、暫停選單、載入與錯誤畫面。 */
export function GameScreen<G extends GameBase>({ create, createKey, settings, bindings, onSettingsChange, onBindingsChange, onLeave, title, loadingText, renderUnlocked, onReady }: GameScreenProps<G>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const debugRef = useRef<HTMLPreElement>(null);
  const [game, setGame] = useState<G | null>(null);
  const createRef = useRef(create);
  const onReadyRef = useRef(onReady);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [locked, setLocked] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [progress, setProgress] = useState<MapLoadProgress | null>(null);

  useEffect(() => {
    createRef.current = create;
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    let created: G | null = null;
    createRef
      .current(container, {
        onPointerLockChange: (isLocked) => {
          setLocked(isLocked);
          if (isLocked) {
            setHasStarted(true);
            setLockError(null);
          }
        },
        onContextLostChange: setContextLost,
        onLoadProgress: setProgress,
      })
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
        onReadyRef.current?.(instance);
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
  }, [createKey]);

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
  const minimapRef = useCallback((el: HTMLCanvasElement | null) => game?.attachMinimap(el), [game]);
  const tacticalRef = useCallback((el: HTMLCanvasElement | null) => game?.attachTacticalMap(el), [game]);

  const unlocked = game && load.status === 'ready' && !locked ? (renderUnlocked?.(game, play, lockError) ?? null) : null;

  return (
    <div className="game-root">
      <div ref={containerRef} className="game-container" />
      <pre ref={debugRef} className="diagnostics" hidden={!settings.showDiagnostics} aria-label="效能資訊" />
      {game && (
        <>
          <Hud store={game.hud} crosshairRef={crosshairRef} onLeave={onLeave} />
          <canvas ref={minimapRef} className="minimap" aria-label="小地圖" />
          <TacticalMapOverlay game={game} canvasRef={tacticalRef} />
        </>
      )}
      {load.status === 'loading' && (
        <div className="overlay overlay--solid">
          <p className="subtitle" role="status">
            {progress?.stage === 'chunks' ? `載入地圖分塊 ${progress.done} / ${progress.total}` : (loadingText ?? '載入中…')}
          </p>
        </div>
      )}
      {load.status === 'error' && (
        <div className="overlay overlay--solid" role="alert">
          <div className="panel">
            <h1 className="title">無法開始</h1>
            <p className="error">{load.message}</p>
            <button type="button" className="button" onClick={onLeave}>
              返回主選單
            </button>
          </div>
        </div>
      )}
      {load.status === 'ready' && !locked && (unlocked ?? (
        <MenuOverlay
          mode={hasStarted ? 'paused' : 'start'}
          title={hasStarted ? '已暫停' : title}
          settings={settings}
          bindings={bindings}
          lockError={lockError}
          onPlay={play}
          onSettingsChange={onSettingsChange}
          onBindingsChange={onBindingsChange}
          onLeave={onLeave}
        />
      ))}
      {contextLost && (
        <div className="banner" role="alert">
          繪圖內容遺失，正在等待瀏覽器恢復…
        </div>
      )}
    </div>
  );
}

function TacticalMapOverlay({ game, canvasRef }: { game: GameBase; canvasRef: (el: HTMLCanvasElement | null) => void }) {
  const show = useHud(game.hud, (s) => s.showMap);
  return <canvas ref={canvasRef} className="tactical-map" hidden={!show} aria-label="戰術地圖" />;
}
