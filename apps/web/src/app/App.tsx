import { useState } from 'react';
import { checkCompatibility } from '../game/core/compatibility';
import { loadSettings, sanitizeSettings, type GameSettings } from '../game/core/settings';
import { CompatibilityNotice } from '../ui/CompatibilityNotice';
import { GameView } from './GameView';

export function App() {
  const [compatibility] = useState(checkCompatibility);
  const [settings, setSettings] = useState<GameSettings>(loadSettings);

  if (!compatibility.supported) {
    return <CompatibilityNotice report={compatibility} />;
  }
  return <GameView settings={settings} onSettingsChange={(next) => setSettings(sanitizeSettings(next))} />;
}
