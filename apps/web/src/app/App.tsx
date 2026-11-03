import { useCallback, useState } from 'react';
import type { Loadout } from '@frontline/game-config';
import { checkCompatibility } from '../game/core/compatibility';
import { loadSettings, loadStoredBindings, sanitizeSettings, saveBindings, saveSettings, type GameSettings } from '../game/core/settings';
import { sanitizeBindings, type KeyBindings } from '../game/input/keyBindings';
import { CompatibilityNotice } from '../ui/CompatibilityNotice';
import { MainMenu, type MenuChoice } from '../ui/MainMenu';
import { SettingsPanel } from '../ui/SettingsPanel';
import { loadProfile, saveProfile, type GuestProfile } from './profile';
import { TrainingView } from './TrainingView';

type Screen =
  | { kind: 'menu' }
  | { kind: 'settings' }
  | { kind: 'training'; mapId: string; loadout: Partial<Loadout> }
  | { kind: 'match'; mode: 'tdm' | 'conquest'; roomId?: string }
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
    return { kind: 'match', mode };
  }
  return { kind: 'menu' };
}

export function App() {
  const [compatibility] = useState(checkCompatibility);
  const [settings, setSettings] = useState<GameSettings>(loadSettings);
  const [bindings, setBindings] = useState<KeyBindings>(() => sanitizeBindings(loadStoredBindings()));
  const [profile, setProfile] = useState<GuestProfile>(loadProfile);
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
              setScreen({ kind: 'match', mode: choice.mode });
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
