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
  const mapId = new URLSearchParams(window.location.search).get('map') ?? 'graybox';
  return <GameView mapId={mapId} settings={settings} onSettingsChange={(next) => setSettings(sanitizeSettings(next))} />;
}
