import { Client, type Room } from '@colyseus/sdk';
import { MSG, type DeployRequest, type InputFrame, type TeamName } from '@frontline/shared';
import type { Loadout } from '@frontline/game-config';
import { gameServerUrl, type GameTransport, type JoinRequest, type TransportHandlers } from './GameTransport';

/** Colyseus 的「主動離開」關閉碼 */
const CONSENTED_CLOSE = 4000;
const REJOIN_WINDOW_MS = 30_000;

/**
 * Colyseus WebSocket 傳輸。
 * - 短暫斷線：由 SDK 自動重連（onDrop → onReconnect）。
 * - SDK 無法恢復的斷線：以同一個訪客身分重新加入同一個房間；伺服器在保留期內把原本的位置還給玩家。
 */
export class ColyseusTransport implements GameTransport {
  private room: Room | null = null;
  private readonly client = new Client(gameServerUrl());
  private request: JoinRequest | null = null;
  private handlers: TransportHandlers | null = null;
  private leaving = false;
  private lastRoomId: string | null = null;

  get roomId(): string | null {
    return this.room?.roomId ?? this.lastRoomId;
  }

  private joinOptions(request: JoinRequest) {
    return {
      mode: request.mode,
      name: request.name,
      guestId: request.guestId,
      ...(request.mapId ? { mapId: request.mapId } : {}),
      ...(request.bots !== undefined ? { bots: request.bots } : {}),
      ...(request.scoreLimit !== undefined ? { scoreLimit: request.scoreLimit } : {}),
      ...(request.timeLimit !== undefined ? { timeLimit: request.timeLimit } : {}),
      ...(request.loadout ? { loadout: request.loadout } : {}),
    };
  }

  async connect(request: JoinRequest, handlers: TransportHandlers): Promise<void> {
    this.request = request;
    this.handlers = handlers;
    handlers.onConnectionChange('connecting');
    const options = this.joinOptions(request);
    const room = request.roomId ? await this.client.joinById(request.roomId, options) : await this.client.joinOrCreate('match', options);
    this.attach(room);
    handlers.onConnectionChange('connected');
  }

  private attach(room: Room): void {
    const handlers = this.handlers!;
    this.room = room;
    this.lastRoomId = room.roomId;
    room.onMessage(MSG.welcome, handlers.onWelcome);
    room.onMessage(MSG.snapshot, handlers.onSnapshot);
    room.onMessage(MSG.events, handlers.onEvents);
    room.onMessage(MSG.match, handlers.onMatchState);
    room.onMessage(MSG.pong, handlers.onPong);
    room.onMessage(MSG.error, (m: { message: string }) => handlers.onError(m.message));
    room.onDrop(() => handlers.onConnectionChange('reconnecting'));
    room.onReconnect(() => handlers.onConnectionChange('connected'));
    room.onLeave((code: number, reason?: string) => {
      if (this.room !== room) {
        return;
      }
      this.room = null;
      if (this.leaving || code === CONSENTED_CLOSE) {
        handlers.onConnectionChange('disconnected', reason ?? String(code));
        return;
      }
      void this.rejoin();
    });
    room.onError((code: number, message?: string) => handlers.onError(message ?? `錯誤 ${code}`));
  }

  /** 以同一個訪客身分重新加入原本的房間（伺服器保留位置 30 秒）。 */
  private async rejoin(): Promise<void> {
    const handlers = this.handlers;
    const request = this.request;
    const roomId = this.lastRoomId;
    if (!handlers || !request || !roomId) {
      return;
    }
    handlers.onConnectionChange('reconnecting');
    const deadline = Date.now() + REJOIN_WINDOW_MS;
    let delay = 500;
    while (!this.leaving && Date.now() < deadline) {
      try {
        const room = await this.client.joinById(roomId, this.joinOptions(request));
        this.attach(room);
        handlers.onConnectionChange('connected');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(4000, delay * 2);
      }
    }
    if (!this.leaving) {
      handlers.onConnectionChange('disconnected', '無法重新連線');
    }
  }

  sendInput(frames: InputFrame[]): void {
    this.room?.send(MSG.input, { frames });
  }

  sendLoadout(loadout: Partial<Loadout>): void {
    this.room?.send(MSG.loadout, loadout);
  }

  sendTeam(team: TeamName): void {
    this.room?.send(MSG.team, { team });
  }

  sendDeploy(request: DeployRequest): void {
    this.room?.send(MSG.deploy, request);
  }

  sendPing(t: number, rtt?: number): void {
    this.room?.send(MSG.ping, rtt === undefined ? { t } : { t, rtt });
  }

  sendDebug(command: { cmd: 'teleport'; x: number; y: number; z: number } | { cmd: 'skipWarmup' }): void {
    this.room?.send(MSG.debug, command);
  }

  /** 測試用：模擬連線中斷（以非正常代碼關閉底層連線）。 */
  simulateDrop(): void {
    this.room?.connection.close(4100, 'simulated drop');
  }

  async leave(): Promise<void> {
    this.leaving = true;
    const room = this.room;
    this.room = null;
    if (room) {
      room.removeAllListeners();
      await room.leave(true).catch(() => undefined);
    }
  }
}
