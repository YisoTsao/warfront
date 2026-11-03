import { useCallback } from 'react';
import type { Loadout } from '@frontline/game-config';
import type { GameCallbacks } from '../game/core/GameBase';
import type { TrainingGame } from '../game/core/TrainingGame';
import type { GameSettings } from '../game/core/settings';
import type { KeyBindings } from '../game/input/keyBindings';
import { GameScreen } from './GameScreen';

interface TrainingViewProps {
  mapId: string;
  loadout: Partial<Loadout>;
  settings: GameSettings;
  bindings: KeyBindings;
  onSettingsChange(settings: GameSettings): void;
  onBindingsChange(bindings: KeyBindings): void;
  onLeave(): void;
}

/** 訓練場（單機）。遊戲本體（Three.js、Rapier WASM）延後載入，選單外殼可以先顯示。 */
export function TrainingView({ mapId, loadout, settings, bindings, onSettingsChange, onBindingsChange, onLeave }: TrainingViewProps) {
  const create = useCallback(
    async (container: HTMLElement, callbacks: GameCallbacks): Promise<TrainingGame> => {
      const { TrainingGame } = await import('../game/core/TrainingGame');
      return TrainingGame.create(container, { mapId, settings, bindings, loadout, callbacks });
    },
    // 只在地圖改變時重建；設定與按鍵由 GameScreen 另外套用
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapId],
  );
  return (
    <GameScreen
      create={create}
      createKey={`training:${mapId}`}
      settings={settings}
      bindings={bindings}
      onSettingsChange={onSettingsChange}
      onBindingsChange={onBindingsChange}
      onLeave={onLeave}
      title="訓練場"
    />
  );
}
