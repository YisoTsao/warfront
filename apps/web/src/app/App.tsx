import { useCallback, useState } from 'react';
import type { Loadout } from '@frontline/game-config';
import { checkCompatibility } from '../game/core/compatibility';
import { loadSettings, loadStoredBindings, sanitizeSettings, saveBindings, saveSettings, type GameSettings } from '../game/core/settings';
import { sanitizeBindings, type KeyBindings } from '../game/input/keyBindings';
import { CompatibilityNotice } from '../ui/CompatibilityNotice';
import { MainMenu, type MenuChoice } from '../ui/MainMenu';
import { ServerList } from '../ui/ServerList';
import { SettingsPanel } from '../ui/SettingsPanel';
import { MatchView, type MatchRequest } from './MatchView';
import { loadProfile, saveProfile, type GuestProfile } from './profile';
import { TrainingView } from './TrainingView';

type Screen =
  | { kind: 'menu' }
  | { kind: 'settings' }
  | { kind: 'training'; mapId: string; loadout: Partial<Loadout> }
  | { kind: 'match'; request: MatchRequest }
  | { kind: 'servers' };

/** 網址參數：?map=xxx 直接進入訓練場（開發與自動化測試使用）。 */
function initialScreen(): Screen {
  const params = new URLSearchParams(window.location.search);
  const map = params.get('map');
  if (map) {
    return { kind: 'training', mapId: map, loadout: { classId: params.get('class') ?? 'assault', ...(params.get('primary') ? { primaryId: params.get('primary')! } : {}) } };
  }
  const mode = params.get('match');
  if (mode === 'tdm' || mode === 'conquest') {
    const bots = params.get('bots');
    return {
      kind: 'match',
      request: {
        mode,
        ...(params.get('matchMap') ? { mapId: params.get('matchMap')! } : {}),
        ...(bots !== null ? { bots: Number(bots) } : {}),
        ...(params.get('scoreLimit') ? { scoreLimit: Number(params.get('scoreLimit')) } : {}),
        ...(params.get('timeLimit') ? { timeLimit: Number(params.get('timeLimit')) } : {}),
      },
    };
  }
  return { kind: 'menu' };
}

export function App() {
  const [compatibility] = useState(checkCompatibility);
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const [bindings, setBindings] = useState<KeyBindings>(() => sanitizeBindings(loadStoredBindings()));
  const [profile, setProfile] = useState<GuestProfile>(() => {
    const loaded = loadProfile();
    // 測試與多分頁：?guest= 與 ?name= 可以覆寫訪客身分
    const params = new URLSearchParams(window.location.search);
    const guest = params.get('guest');
    const name = params.get('name');
    return { guestId: guest ?? loaded.guestId, name: name ?? loaded.name };
  });
  const [screen, setScreen] = useState<Screen>(initialScreen);

  const updateSettings = useCallback((next: GameSettings) => {
    const clean = sanitizeSettings(next);
    setSettings(clean);
    saveSettings(clean);
  }, []);
  const updateBindings = useCallback((next: KeyBindings) => {
    setBindings(next);
    saveBindings(next);
  }, []);
  const toMenu = useCallback(() => setScreen({ kind: 'menu' }), []);

  if (!compatibility.supported) {
    return <CompatibilityNotice report={compatibility} />;
  }

  switch (screen.kind) {
    case 'training':
      return (
        <TrainingView
          mapId={screen.mapId}
          loadout={screen.loadout}
          settings={settings}
          bindings={bindings}
          onSettingsChange={updateSettings}
          onBindingsChange={updateBindings}
          onLeave={toMenu}
        />
      );
    case 'match':
      return (
        <MatchView
          request={screen.request}
          profile={profile}
          settings={settings}
          bindings={bindings}
          onSettingsChange={updateSettings}
          onBindingsChange={updateBindings}
          onLeave={toMenu}
        />
      );
    case 'servers':
      return <ServerList onBack={toMenu} onJoin={(room) => setScreen({ kind: 'match', request: { mode: room.mode, roomId: room.roomId, ...(room.mapId ? { mapId: room.mapId } : {}) } })} />;
    case 'settings':
      return (
        <div className="overlay overlay--solid">
          <div className="panel panel--wide">
            <h1 className="title">設定</h1>
            <SettingsPanel settings={settings} onChange={updateSettings} bindings={bindings} onBindingsChange={updateBindings} />
            <button type="button" className="button button--primary" onClick={toMenu}>
              返回
            </button>
          </div>
        </div>
      );
    case 'menu':
    default:
      return (
        <MainMenu
          profile={profile}
          onProfileChange={(p) => {
            setProfile(p);
            saveProfile(p);
          }}
          onChoose={(choice: MenuChoice) => {
            if (choice.kind === 'training') {
              setScreen({ kind: 'training', mapId: choice.mapId, loadout: choice.loadout });
            } else if (choice.kind === 'quickMatch') {
              setScreen({ kind: 'match', request: { mode: choice.mode, mapId: choice.mapId, bots: choice.bots } });
            } else if (choice.kind === 'serverList') {
              setScreen({ kind: 'servers' });
            } else {
              setScreen({ kind: 'settings' });
            }
          }}
        />
      );
  }
}
