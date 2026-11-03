import { readFileSync } from 'node:fs';
import { Room, ServerError, type AuthContext, type Client } from '@colyseus/core';
import { MATCH_LIMITS, type Loadout } from '@frontline/game-config';
import { MSG, SNAPSHOT_EVERY_TICKS, TICK_RATE, type WelcomeMessage } from '@frontline/shared';
import { initPhysics, loadMapData } from '@frontline/simulation';
import { config, mapExists } from '../config';
import { Match } from '../game/Match';
import { log } from '../logger';
import { metrics, type RoomMetrics } from '../metrics';
import { JsonlResultReporter } from '../persistence/ResultReporter';
import { JoinLimiter, TokenBucket } from './RateLimiter';
import { DebugSchema, DeploySchema, InputMessageSchema, JoinOptionsSchema, LoadoutSchema, PingSchema, TeamSchema } from './schemas';

const joinLimiter = new JoinLimiter(12, 10_000);

/** zod 的選填欄位是 `T | undefined`，轉成沒有 undefined 值的 Partial<Loadout>。 */
function toLoadout(input: { classId: string; primaryId?: string | undefined; secondaryId?: string | undefined; attachments?: Record<string, string[]> | undefined }): Partial<Loadout> {
  return {
    classId: input.classId,
    ...(input.primaryId ? { primaryId: input.primaryId } : {}),
    ...(input.secondaryId ? { secondaryId: input.secondaryId } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
}
const reporter = new JsonlResultReporter(config.resultsLog);

interface ClientInfo {
  number: number;
  inputBucket: TokenBucket;
  messageBucket: TokenBucket;
  dropped: number;
  droppedWindowStart: number;
}

export interface MatchRoomMetadata {
  mode: 'tdm' | 'conquest';
  mapId: string;
  mapName: string;
  humans: number;
  bots: number;
  phase: string;
}

/**
 * Colyseus 房間：一個房間就是一場對戰。遊戲規則都在 Match；這裡負責
 * 加入驗證、訊息結構驗證與限流、斷線重連、固定 tick 推進與送出快照。
 */
export class MatchRoom extends Room {
  override maxClients = MATCH_LIMITS.maxPlayers;
  private match!: Match;
  private readonly clientsInfo = new Map<string, ClientInfo>();
  private m!: RoomMetrics;
  private lastTickAt = 0;
  private mode: 'tdm' | 'conquest' = 'tdm';
  private mapId = 'graybox';

  override async onCreate(options: unknown): Promise<void> {
    const parsed = JoinOptionsSchema.partial().safeParse(options ?? {});
    const opts = parsed.success ? parsed.data : {};
    this.mode = opts.mode ?? 'tdm';
    const requested = opts.mapId ?? config.defaultMap;
    this.mapId = mapExists(requested) ? requested : 'graybox';
    if (this.mapId !== requested) {
      log('warn', 'map_not_found_fallback', { requested, mapsDir: config.mapsDir });
    }
    await initPhysics();
    const map = await loadMapData(this.mapId, config.mapsDir, async (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown);
    this.match = new Match({
      map,
      mode: this.mode,
      botFill: opts.bots ?? config.defaultBotFill,
      ...(config.warmupSeconds !== undefined ? { warmupSeconds: config.warmupSeconds } : {}),
      ...(config.resultSeconds !== undefined ? { resultSeconds: config.resultSeconds } : {}),
      modeOverrides: {
        ...(opts.scoreLimit !== undefined ? { scoreLimit: opts.scoreLimit, startingTickets: opts.scoreLimit } : {}),
        ...(opts.timeLimit !== undefined ? { timeLimitSeconds: opts.timeLimit } : {}),
      },
      onMatchEnd: (result) => {
        metrics.count('matchesCompleted');
        void reporter.report({
          matchId: `${this.roomId}-${Date.now()}`,
          roomId: this.roomId,
          mapId: result.mapId,
          mode: result.mode,
          endedAt: new Date().toISOString(),
          durationSeconds: result.durationSeconds,
          winner: result.winner,
          scores: result.scores,
          players: result.players.map((p) => ({ guestId: p.guestId, name: p.name, team: p.team, bot: p.bot, kills: p.kills, deaths: p.deaths, assists: p.assists, score: p.score })),
        });
      },
    });
    this.m = metrics.room(this.roomId, this.mode, this.mapId);
    this.autoDispose = true;
    this.updateMetadata();
    this.registerMessages();
    this.lastTickAt = performance.now();
    this.setSimulationInterval(() => this.tick(), 1000 / TICK_RATE);
    log('info', 'room_created', { roomId: this.roomId, mode: this.mode, mapId: this.mapId });
  }

  override onAuth(client: Client, options: unknown, context: AuthContext): { guestId: string; name: string } {
    const ip = context.ip ?? 'unknown';
    if (!joinLimiter.allow(ip)) {
      metrics.count('joinsRejected');
      throw new ServerError(429, '加入太頻繁，請稍後再試');
    }
    if (config.allowedOrigins.length > 0) {
      const origin = context.headers.get('origin') ?? '';
      if (!config.allowedOrigins.includes(origin)) {
        metrics.count('joinsRejected');
        throw new ServerError(403, '不允許的來源');
      }
    }
    const parsed = JoinOptionsSchema.safeParse(options);
    if (!parsed.success) {
      metrics.count('joinsRejected');
      throw new ServerError(400, '加入參數格式錯誤');
    }
    const existing = this.match.findByGuest(parsed.data.guestId);
    if (existing && existing.connected) {
      metrics.count('joinsRejected');
      throw new ServerError(409, '你已經在這場對戰中（同一個瀏覽器不能重複加入）');
    }
    void client;
    const name = parsed.data.name.replace(/[<>]/g, '').trim().slice(0, 16) || '士兵';
    return { guestId: parsed.data.guestId, name };
  }

  override onJoin(client: Client, options: unknown, auth: { guestId: string; name: string }): void {
    const parsed = JoinOptionsSchema.safeParse(options);
    // 斷線保留期間以同一個訪客身分重新加入：取回原本的位置與分數
    let player = this.match.findByGuest(auth.guestId);
    if (player && !player.connected) {
      this.match.setConnected(player.number, true, client.sessionId);
      metrics.count('reconnects');
    } else {
      player = this.match.addPlayer({
        guestId: auth.guestId,
        name: auth.name,
        sessionId: client.sessionId,
        ...(parsed.success && parsed.data.loadout ? { loadout: toLoadout(parsed.data.loadout) } : {}),
      });
    }
    this.clientsInfo.set(client.sessionId, {
      number: player.number,
      inputBucket: new TokenBucket(100, 120),
      messageBucket: new TokenBucket(10, 20),
      dropped: 0,
      droppedWindowStart: Date.now(),
    });
    metrics.count('connections');
    this.sendWelcome(client);
    this.updateMetadata();
    log('info', 'player_joined', { roomId: this.roomId, player: player.number, name: player.name, team: player.team });
  }

  override onDrop(client: Client): void {
    const info = this.clientsInfo.get(client.sessionId);
    if (info) {
      this.match.setConnected(info.number, false);
    }
    metrics.count('disconnects');
    this.allowReconnection(client, config.reconnectSeconds);
    log('info', 'player_dropped', { roomId: this.roomId, player: info?.number });
  }

  override onReconnect(client: Client): void {
    const info = this.clientsInfo.get(client.sessionId);
    if (info) {
      this.match.setConnected(info.number, true, client.sessionId);
      metrics.count('reconnects');
      this.sendWelcome(client);
    }
    log('info', 'player_reconnected', { roomId: this.roomId, player: info?.number });
  }

  override onLeave(client: Client): void {
    const info = this.clientsInfo.get(client.sessionId);
    this.clientsInfo.delete(client.sessionId);
    if (info) {
      const player = this.match.players.get(info.number);
      // 同一個訪客已經用新的連線取回位置時，不要移除
      if (player && player.sessionId === client.sessionId) {
        this.match.removePlayer(info.number);
      }
    }
    this.updateMetadata();
    log('info', 'player_left', { roomId: this.roomId, player: info?.number });
  }

  override onDispose(): void {
    this.match.dispose();
    metrics.removeRoom(this.roomId);
    log('info', 'room_disposed', { roomId: this.roomId });
  }

  override onUncaughtException(error: unknown, methodName: string): void {
    if (methodName === 'onAuth') {
      // 加入被拒絕（重複加入、格式錯誤、限流）是預期內的情況
      log('info', 'join_rejected', { roomId: this.roomId, reason: String(error) });
      return;
    }
    metrics.count('roomErrors');
    log('error', 'room_exception', { roomId: this.roomId, method: methodName, error: String(error) });
  }

  private sendWelcome(client: Client): void {
    const info = this.clientsInfo.get(client.sessionId);
    const player = info ? this.match.players.get(info.number) : undefined;
    if (!player) {
      return;
    }
    const welcome: WelcomeMessage = {
      sessionId: client.sessionId,
      playerNumber: player.number,
      team: player.team,
      matchSeed: this.match.matchSeed,
      tickRate: TICK_RATE,
      mapId: this.mapId,
      mode: this.mode,
      serverTick: this.match.tick,
      maxPlayers: MATCH_LIMITS.maxPlayers,
    };
    client.send(MSG.welcome, welcome);
    client.send(MSG.match, this.match.matchState());
  }

  /** 限流：超過速率的訊息丟棄；10 秒內丟棄太多次就中斷連線。 */
  private allowMessage(client: Client, kind: 'input' | 'other'): ClientInfo | null {
    const info = this.clientsInfo.get(client.sessionId);
    if (!info) {
      return null;
    }
    this.m.messagesIn++;
    const ok = kind === 'input' ? info.inputBucket.take() : info.messageBucket.take();
    if (ok) {
      return info;
    }
    this.m.rateLimited++;
    const now = Date.now();
    if (now - info.droppedWindowStart > 10_000) {
      info.dropped = 0;
      info.droppedWindowStart = now;
    }
    info.dropped++;
    if (info.dropped > 300) {
      log('warn', 'client_rate_limit_disconnect', { roomId: this.roomId, player: info.number });
      client.leave(4003, '訊息頻率過高');
    }
    return null;
  }

  private registerMessages(): void {
    this.onMessage(MSG.input, (client, message: unknown) => {
      const info = this.allowMessage(client, 'input');
      const parsed = InputMessageSchema.safeParse(message);
      if (!info || !parsed.success) {
        if (!parsed.success) {
          this.m.rejected++;
        }
        return;
      }
      for (const frame of parsed.data.frames) {
        if (!this.match.pushInput(info.number, frame)) {
          this.m.rejected++;
        }
      }
    });
    this.onMessage(MSG.loadout, (client, message: unknown) => {
      const info = this.allowMessage(client, 'other');
      const parsed = LoadoutSchema.safeParse(message);
      if (info && parsed.success) {
        this.match.setLoadout(info.number, toLoadout(parsed.data));
      }
    });
    this.onMessage(MSG.team, (client, message: unknown) => {
      const info = this.allowMessage(client, 'other');
      const parsed = TeamSchema.safeParse(message);
      if (info && parsed.success) {
        if (this.match.requestTeam(info.number, parsed.data.team)) {
          this.sendWelcome(client);
        } else {
          client.send(MSG.error, { message: '無法換隊：隊伍人數已滿或會造成人數不平衡' });
        }
        this.updateMetadata();
      }
    });
    this.onMessage(MSG.deploy, (client, message: unknown) => {
      const info = this.allowMessage(client, 'other');
      const parsed = DeploySchema.safeParse(message);
      if (info && parsed.success) {
        this.match.deploy(info.number, parsed.data.spawn);
      }
    });
    this.onMessage(MSG.debug, (client, message: unknown) => {
      const info = this.allowMessage(client, 'other');
      const parsed = DebugSchema.safeParse(message);
      if (!config.devCommands || !info || !parsed.success) {
        return;
      }
      if (parsed.data.cmd === 'teleport') {
        this.match.debugTeleport(info.number, { x: parsed.data.x, y: parsed.data.y, z: parsed.data.z });
      } else {
        this.match.skipWarmup();
      }
    });
    this.onMessage(MSG.ping, (client, message: unknown) => {
      const info = this.allowMessage(client, 'other');
      const parsed = PingSchema.safeParse(message);
      if (!info || !parsed.success) {
        return;
      }
      if (parsed.data.rtt !== undefined) {
        const player = this.match.players.get(info.number);
        if (player) {
          player.ping = Math.round(parsed.data.rtt);
        }
        metrics.ping(this.m, parsed.data.rtt);
      }
      client.send(MSG.pong, { t: parsed.data.t, tick: this.match.tick });
    });
  }

  private tick(): void {
    const started = performance.now();
    const drift = started - this.lastTickAt - 1000 / TICK_RATE;
    this.lastTickAt = started;
    this.match.step();

    const events = this.match.drainEvents();
    if (events.broadcast.length > 0) {
      this.broadcast(MSG.events, { t: this.match.tick, events: events.broadcast });
    }
    for (const [number, list] of events.private) {
      const client = this.clientFor(number);
      client?.send(MSG.events, { t: this.match.tick, events: list });
    }
    if (this.match.tick % SNAPSHOT_EVERY_TICKS === 0) {
      for (const client of this.clients) {
        const info = this.clientsInfo.get(client.sessionId);
        if (info) {
          const snapshot = this.match.snapshotFor(info.number);
          client.send(MSG.snapshot, snapshot);
          if (this.match.tick % (SNAPSHOT_EVERY_TICKS * 15) === 0) {
            metrics.snapshot(this.m, JSON.stringify(snapshot).length);
          } else {
            this.m.messagesOut++;
          }
        }
      }
    }
    if (this.match.tick % (TICK_RATE / 2) === 0) {
      this.broadcast(MSG.match, this.match.matchState());
      this.updateMetadata();
    }
    this.m.suspicious = this.match.counters.suspicious;
    metrics.tick(this.m, performance.now() - started, drift);
  }

  private clientFor(number: number): Client | undefined {
    for (const client of this.clients) {
      if (this.clientsInfo.get(client.sessionId)?.number === number) {
        return client;
      }
    }
    return undefined;
  }

  private updateMetadata(): void {
    const players = [...this.match.players.values()];
    this.m.humans = players.filter((p) => !p.bot).length;
    this.m.bots = players.filter((p) => p.bot).length;
    void this.setMetadata({
      mode: this.mode,
      mapId: this.mapId,
      mapName: this.match.manifest.name,
      humans: this.m.humans,
      bots: this.m.bots,
      phase: this.match.phase,
    } satisfies MatchRoomMetadata);
  }
}
