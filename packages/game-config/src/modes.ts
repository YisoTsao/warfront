export type GameModeId = 'tdm' | 'conquest';

export interface TeamDeathmatchConfig {
  id: 'tdm';
  displayName: string;
  scoreLimit: number;
  timeLimitSeconds: number;
  respawnSeconds: number;
  friendlyFire: boolean;
  /** 倒地與救援（規格 §6：只在模式需要時啟用） */
  downedEnabled: boolean;
}

export interface ConquestConfig {
  id: 'conquest';
  displayName: string;
  startingTickets: number;
  timeLimitSeconds: number;
  respawnSeconds: number;
  friendlyFire: boolean;
  downedEnabled: boolean;
  /** 佔領一個據點所需的秒數（單人；多人加速，有上限） */
  captureSeconds: number;
  maxCaptureMultiplier: number;
  /** 一隊擁有多數據點時，對方每秒流失的票數 */
  bleedPerSecond: number;
  /** 每死亡一人扣的票數 */
  ticketsPerDeath: number;
}

export type GameModeConfig = TeamDeathmatchConfig | ConquestConfig;

export const MATCH_LIMITS = {
  maxPlayers: 16,
  maxPerTeam: 8,
  /** 開局倒數 */
  warmupSeconds: 5,
  /** 結算畫面時間，之後自動開始下一場 */
  resultSeconds: 12,
  /** 斷線保留位置的秒數 */
  reconnectGraceSeconds: 30,
} as const;

export const GAME_MODES: Record<GameModeId, GameModeConfig> = {
  tdm: {
    id: 'tdm',
    displayName: '團隊死鬥',
    scoreLimit: 50,
    timeLimitSeconds: 600,
    respawnSeconds: 5,
    friendlyFire: false,
    downedEnabled: false,
  },
  conquest: {
    id: 'conquest',
    displayName: '征服',
    startingTickets: 150,
    timeLimitSeconds: 1200,
    respawnSeconds: 8,
    friendlyFire: false,
    downedEnabled: true,
    captureSeconds: 10,
    maxCaptureMultiplier: 3,
    bleedPerSecond: 0.5,
    ticketsPerDeath: 1,
  },
};

export function getMode(id: string): GameModeConfig {
  return id === 'conquest' ? GAME_MODES.conquest : GAME_MODES.tdm;
}
