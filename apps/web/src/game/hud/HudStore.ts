import { useSyncExternalStore } from 'react';

export interface KillFeedEntry {
  id: number;
  killer: string;
  killerTeam: 'alpha' | 'bravo' | null;
  victim: string;
  victimTeam: 'alpha' | 'bravo' | null;
  weapon: string;
  headshot: boolean;
  at: number;
}

export interface ScoreboardRow {
  id: string;
  name: string;
  team: 'alpha' | 'bravo';
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  ping: number;
  alive: boolean;
  connected: boolean;
  bot: boolean;
  classId: string;
  isSelf: boolean;
}

export interface ObjectiveHud {
  id: string;
  name: string;
  owner: 'alpha' | 'bravo' | null;
  /** -1（Bravo 佔領）到 1（Alpha 佔領） */
  progress: number;
  contested: boolean;
  inside: boolean;
}

export interface HudState {
  health: number;
  maxHealth: number;
  lifeState: 'alive' | 'downed' | 'dead';
  weaponName: string;
  fireMode: string;
  ammo: number;
  reserve: number;
  reloading: boolean;
  grenades: number;
  abilityName: string;
  abilityReadyIn: number;
  hitMarker: { serial: number; headshot: boolean; kill: boolean };
  damageFrom: { serial: number; angle: number };
  killFeed: KillFeedEntry[];
  /** 對戰資訊（線上模式） */
  mode: 'offline' | 'tdm' | 'conquest';
  phase: 'warmup' | 'active' | 'ended' | 'offline';
  timeLeft: number;
  teamScores: { alpha: number; bravo: number };
  scoreLimit: number;
  team: 'alpha' | 'bravo' | null;
  respawnIn: number;
  bleedoutIn: number;
  reviveProgress: number;
  objectives: ObjectiveHud[];
  scoreboard: ScoreboardRow[];
  showScoreboard: boolean;
  showMap: boolean;
  ping: number;
  connection: 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  message: string | null;
  restrictedWarning: number;
  winner: 'alpha' | 'bravo' | 'draw' | null;
  spotted: boolean;
}

const INITIAL: HudState = {
  health: 100,
  maxHealth: 100,
  lifeState: 'alive',
  weaponName: '',
  fireMode: '',
  ammo: 0,
  reserve: 0,
  reloading: false,
  grenades: 0,
  abilityName: '',
  abilityReadyIn: 0,
  hitMarker: { serial: 0, headshot: false, kill: false },
  damageFrom: { serial: 0, angle: 0 },
  killFeed: [],
  mode: 'offline',
  phase: 'offline',
  timeLeft: 0,
  teamScores: { alpha: 0, bravo: 0 },
  scoreLimit: 0,
  team: null,
  respawnIn: 0,
  bleedoutIn: 0,
  reviveProgress: 0,
  objectives: [],
  scoreboard: [],
  showScoreboard: false,
  showMap: false,
  ping: 0,
  connection: 'offline',
  message: null,
  restrictedWarning: 0,
  winner: null,
  spotted: false,
};

/**
 * HUD 狀態。遊戲迴圈呼叫 set()，只有值真的改變時才通知 React；
 * 每畫格變動的東西（準星大小）不放在這裡，而是直接寫 DOM。
 */
export class HudStore {
  private state: HudState = INITIAL;
  private readonly listeners = new Set<() => void>();

  get(): HudState {
    return this.state;
  }

  set(partial: Partial<HudState>): void {
    let changed = false;
    for (const key of Object.keys(partial) as Array<keyof HudState>) {
      if (!Object.is(this.state[key], partial[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  }

  reset(): void {
    this.state = INITIAL;
    for (const listener of this.listeners) {
      listener();
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useHud<T>(store: HudStore, selector: (state: HudState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
