import { useCallback, useState } from 'react';
import type { GameCallbacks } from '../game/core/GameBase';
import type { OnlineGame } from '../game/core/OnlineGame';
import type { GameSettings } from '../game/core/settings';
import { useHud } from '../game/hud/HudStore';
import type { KeyBindings } from '../game/input/keyBindings';
import { DeployScreen, loadSavedLoadout } from '../ui/DeployScreen';
import { MenuOverlay } from '../ui/MenuOverlay';
import { SettingsPanel } from '../ui/SettingsPanel';
import { GameScreen } from './GameScreen';
import type { GuestProfile } from './profile';

export interface MatchRequest {
  mode: 'tdm' | 'conquest';
  mapId?: string;
  roomId?: string;
  bots?: number;
  scoreLimit?: number;
  timeLimit?: number;
}

interface MatchViewProps {
  request: MatchRequest;
  profile: GuestProfile;
  settings: GameSettings;
  bindings: KeyBindings;
  onSettingsChange(settings: GameSettings): void;
  onBindingsChange(bindings: KeyBindings): void;
  onLeave(): void;
}

/** 線上對戰：連線、部署、遊玩、暫停、結算。 */
export function MatchView({ request, profile, settings, bindings, onSettingsChange, onBindingsChange, onLeave }: MatchViewProps) {
  const create = useCallback(
    async (container: HTMLElement, callbacks: GameCallbacks): Promise<OnlineGame> => {
      const { OnlineGame } = await import('../game/core/OnlineGame');
      return OnlineGame.create(container, {
        settings,
        bindings,
        loadout: loadSavedLoadout(),
        callbacks,
        join: { ...request, name: profile.name, guestId: profile.guestId, loadout: loadSavedLoadout() },
      });
    },
    // 只在對戰請求改變時重新連線
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [request.mode, request.mapId, request.roomId, request.bots, request.scoreLimit, request.timeLimit],
  );

  const leave = useCallback(() => {
    onLeave();
  }, [onLeave]);

  return (
    <GameScreen
      create={create}
      createKey={`match:${request.mode}:${request.mapId ?? ''}:${request.roomId ?? ''}:${request.bots ?? ''}`}
      settings={settings}
      bindings={bindings}
      onSettingsChange={onSettingsChange}
      onBindingsChange={onBindingsChange}
      onLeave={leave}
      title="線上對戰"
      loadingText="連線到對戰伺服器…"
      renderUnlocked={(game, play, lockError) => (
        <MatchUnlocked
          game={game}
          play={play}
          lockError={lockError}
          settings={settings}
          bindings={bindings}
          onSettingsChange={onSettingsChange}
          onBindingsChange={onBindingsChange}
          onLeave={leave}
        />
      )}
    />
  );
}

interface MatchUnlockedProps {
  game: OnlineGame;
  play(): void;
  lockError: string | null;
  settings: GameSettings;
  bindings: KeyBindings;
  onSettingsChange(settings: GameSettings): void;
  onBindingsChange(bindings: KeyBindings): void;
  onLeave(): void;
}

/** 滑鼠未鎖定時：陣亡或剛加入顯示部署畫面，存活時顯示暫停選單。 */
function MatchUnlocked({ game, play, lockError, settings, bindings, onSettingsChange, onBindingsChange, onLeave }: MatchUnlockedProps) {
  const lifeState = useHud(game.hud, (s) => s.lifeState);
  const phase = useHud(game.hud, (s) => s.phase);
  const [showSettings, setShowSettings] = useState(false);
  if (phase === 'ended') {
    return null; // 結算畫面由 HUD 顯示
  }
  if (showSettings) {
    return (
      <div className="overlay">
        <div className="panel panel--wide">
          <h1 className="title">設定</h1>
          <SettingsPanel settings={settings} onChange={onSettingsChange} bindings={bindings} onBindingsChange={onBindingsChange} />
          <button type="button" className="button button--primary" onClick={() => setShowSettings(false)}>
            返回
          </button>
        </div>
      </div>
    );
  }
  if (lifeState === 'dead') {
    return (
      <DeployScreen
        store={game.hud}
        lockError={lockError}
        onDeploy={(loadout, spawn) => {
          game.deploy(loadout, spawn);
          play();
        }}
        onTeam={(team) => game.requestTeam(team)}
        onLeave={onLeave}
        onSettings={() => setShowSettings(true)}
      />
    );
  }
  return (
    <MenuOverlay
      mode="paused"
      settings={settings}
      bindings={bindings}
      lockError={lockError}
      onPlay={play}
      onSettingsChange={onSettingsChange}
      onBindingsChange={onBindingsChange}
      onLeave={onLeave}
      leaveLabel="離開對戰"
    />
  );
}
