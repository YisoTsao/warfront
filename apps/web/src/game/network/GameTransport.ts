import type { DeployRequest, EventsMessage, InputFrame, MatchStateMessage, SnapshotMessage, TeamName, WelcomeMessage } from '@frontline/shared';
import type { Loadout } from '@frontline/game-config';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface JoinRequest {
  mode: 'tdm' | 'conquest';
  mapId?: string;
  roomId?: string;
  bots?: number;
  scoreLimit?: number;
  timeLimit?: number;
  name: string;
  guestId: string;
  loadout?: Partial<Loadout>;
}

export interface TransportHandlers {
  onWelcome(message: WelcomeMessage): void;
  onSnapshot(message: SnapshotMessage): void;
  onEvents(message: EventsMessage): void;
  onMatchState(message: MatchStateMessage): void;
  onPong(message: { t: number; tick: number }): void;
  onError(message: string): void;
  onConnectionChange(state: ConnectionState, detail?: string): void;
}

/**
 * 應用層的傳輸介面（主規格 §2.4）。遊戲系統只透過這個介面送收訊息，
 * 之後若改用 WebTransport 傳送移動快照，只需要換實作。
 */
export interface GameTransport {
  connect(request: JoinRequest, handlers: TransportHandlers): Promise<void>;
  sendInput(frames: InputFrame[]): void;
  sendLoadout(loadout: Partial<Loadout>): void;
  sendTeam(team: TeamName): void;
  sendDeploy(request: DeployRequest): void;
  sendPing(t: number, rtt?: number): void;
  /** 開發用指令（伺服器未啟用時會被忽略） */
  sendDebug(command: { cmd: 'teleport'; x: number; y: number; z: number } | { cmd: 'skipWarmup' }): void;
  /** 測試用：模擬網路中斷（關閉底層連線，觸發自動重連） */
  simulateDrop(): void;
  leave(): Promise<void>;
  readonly roomId: string | null;
}

/** 對戰伺服器位址：VITE_GAME_SERVER_URL，未設定時用同一主機的 2567 埠。 */
export function gameServerUrl(): string {
  const configured = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  if (configured) {
    return configured;
  }
  const params = new URLSearchParams(window.location.search);
  const override = params.get('server');
  if (override) {
    return override;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.hostname}:2567`;
}

export function gameServerHttpUrl(): string {
  return gameServerUrl().replace(/^ws/, 'http');
}
