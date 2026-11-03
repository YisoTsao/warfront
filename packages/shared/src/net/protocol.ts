/**
 * 網路訊息格式（前端與伺服器共用的型別）。執行期的結構驗證在伺服器端以 zod 進行。
 * 客戶端只送「輸入」，不送位置、命中或傷害；開火也是輸入的一部分（扳機按鈕），
 * 由伺服器以相同的武器狀態機產生射擊。
 */

export const MSG = {
  /** 客戶端 → 伺服器：每個 tick 一個輸入框 */
  input: 'in',
  /** 客戶端 → 伺服器：配裝（下次部署生效） */
  loadout: 'loadout',
  /** 客戶端 → 伺服器：換隊 */
  team: 'team',
  /** 客戶端 → 伺服器：部署（出生） */
  deploy: 'deploy',
  /** 雙向：延遲量測 */
  ping: 'ping',
  pong: 'pong',
  /** 伺服器 → 客戶端 */
  welcome: 'welcome',
  snapshot: 'snap',
  events: 'ev',
  match: 'match',
  error: 'err',
  /** 開發用指令（只有伺服器設定 DEV_COMMANDS=1 時有效，正式環境停用） */
  debug: 'dbg',
} as const;

/** 輸入按鈕位元 */
export const BUTTON = {
  sprint: 1 << 0,
  jump: 1 << 1,
  aim: 1 << 2,
  fire: 1 << 3,
  reload: 1 << 4,
  fireMode: 1 << 5,
  grenade: 1 << 6,
  ability: 1 << 7,
  interact: 1 << 8,
  giveUp: 1 << 9,
} as const;

/** 只在按下那一刻有效的按鈕（伺服器重複使用上一個輸入時會清掉） */
export const EDGE_BUTTONS = BUTTON.jump | BUTTON.reload | BUTTON.fireMode | BUTTON.grenade | BUTTON.ability;

export const STANCE_CODES = ['standing', 'crouching', 'prone'] as const;
export const LOCOMOTION_CODES = ['idle', 'walking', 'sprinting', 'airborne'] as const;
export const LIFE_CODES = ['alive', 'downed', 'dead', 'spectating'] as const;
export type LifeState = (typeof LIFE_CODES)[number];
export type TeamName = 'alpha' | 'bravo';

export interface InputFrame {
  /** 遞增序號 */
  s: number;
  /** 前後軸 -1、0、1 */
  f: number;
  /** 左右軸 -1、0、1 */
  r: number;
  /** 按鈕位元 */
  b: number;
  /** 想要的姿勢 0 站、1 蹲、2 臥 */
  st: number;
  /** yaw / pitch（弧度） */
  y: number;
  p: number;
  /** 想要的武器欄位 */
  w: number;
  /** 客戶端畫面上遠端玩家所在的伺服器 tick（延遲補償用） */
  vt: number;
}

export interface WelcomeMessage {
  sessionId: string;
  playerNumber: number;
  team: TeamName;
  matchSeed: number;
  tickRate: number;
  mapId: string;
  mode: 'tdm' | 'conquest';
  serverTick: number;
  maxPlayers: number;
}

export interface WeaponWire {
  /** 武器 id */
  id: string;
  ammo: number;
  reserve: number;
  seq: number;
  fm: number;
  rl: boolean;
}

export interface SelfStateWire {
  feet: [number, number, number];
  vel: [number, number, number];
  int: [number, number];
  g: boolean;
  st: number;
  life: number;
  hp: number;
  maxHp: number;
  slot: number;
  weapons: WeaponWire[];
  grenades: number;
  abilityReadyIn: number;
  respawnIn: number;
  bleedoutIn: number;
  reviveProgress: number;
  restrictedIn: number;
  classId: string;
  spotted: boolean;
}

/**
 * 遠端玩家（緊湊陣列）：
 * [編號, x, y, z, yaw, pitch, 姿勢, 移動狀態, 生死, 隊伍(0/1), 目前武器 id, 旗標]
 * 旗標位元：1 = 被標定、2 = 斷線、4 = bot
 */
export type RemotePlayerWire = [number, number, number, number, number, number, number, number, number, number, string, number];

export interface GrenadeWire {
  id: number;
  p: [number, number, number];
}

export interface SnapshotMessage {
  /** 伺服器 tick */
  t: number;
  /** 最後處理的輸入序號 */
  ack: number;
  self: SelfStateWire | null;
  players: RemotePlayerWire[];
  grenades: GrenadeWire[];
}

export type GameEvent =
  | { k: 'shot'; p: number; o: [number, number, number]; e: [number, number, number][]; m: string; w: string }
  | { k: 'hit'; target: number; zone: string; damage: number; kill: boolean }
  | { k: 'damaged'; from: [number, number, number]; amount: number }
  | { k: 'kill'; killer: number | null; killerName: string; killerTeam: TeamName | null; victim: number; victimName: string; victimTeam: TeamName; weapon: string; headshot: boolean }
  | { k: 'explosion'; p: [number, number, number] }
  | { k: 'spawn'; p: number }
  | { k: 'revived'; p: number; by: number }
  | { k: 'ability'; p: number; kind: string; at: [number, number, number] }
  | { k: 'captured'; id: string; team: TeamName | null }
  | { k: 'message'; text: string };

export interface EventsMessage {
  t: number;
  events: GameEvent[];
}

export interface ScoreboardWire {
  n: number;
  name: string;
  team: TeamName;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  ping: number;
  alive: boolean;
  connected: boolean;
  bot: boolean;
  classId: string;
}

export interface ObjectiveWire {
  id: string;
  name: string;
  owner: TeamName | null;
  progress: number;
  contested: boolean;
  position: [number, number, number];
  radius: number;
}

export interface MatchStateMessage {
  phase: 'warmup' | 'active' | 'ended';
  timeLeft: number;
  scores: { alpha: number; bravo: number };
  scoreLimit: number;
  winner: TeamName | 'draw' | null;
  objectives: ObjectiveWire[];
  players: ScoreboardWire[];
}

export interface DeployRequest {
  /** 'base' 或據點 id（征服模式） */
  spawn: string;
}
