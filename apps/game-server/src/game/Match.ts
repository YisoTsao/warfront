import { MATCH_LIMITS, damageAtDistance, getMode, type GameModeConfig, type Loadout } from '@frontline/game-config';
import { pointInBounds, type MapManifest } from '@frontline/map-schema';
import {
  BUTTON,
  LIFE_CODES,
  LOCOMOTION_CODES,
  STANCE_CODES,
  TICK_RATE,
  TICK_SECONDS,
  createRng,
  directionFromYawPitch,
  eyeHeight,
  hashString,
  type GameEvent,
  type InputFrame,
  type MatchStateMessage,
  type RemotePlayerWire,
  type ScoreboardWire,
  type SelfStateWire,
  type SnapshotMessage,
  type TeamName,
  type Vec3,
} from '@frontline/shared';
import {
  SimWorld,
  characterInputFrom,
  has,
  pelletDirections,
  raycastHitbox,
  sanitizeFrame,
  shotSeed,
  spreadDegrees,
  waterDepthAt,
  waterSpeedScale,
  weaponInputFrom,
  zoneMultiplier,
  type HitZone,
  type LoadedMapData,
  type WeaponEvent,
} from '@frontline/simulation';
import { BotBrain } from './bots';
import { createGrenade, explosionDamage, stepGrenade, type Grenade } from './grenades';
import { LagCompensation, type PoseRecord } from './LagCompensation';
import { createMode, otherTeam, type ModeRules } from './modes';
import { ServerPlayer } from './ServerPlayer';
import { chooseSpawn } from './spawns';

export type MatchPhase = 'warmup' | 'active' | 'ended';

export interface MatchOptions {
  map: LoadedMapData;
  mode: 'tdm' | 'conquest';
  /** 總人數目標：不足時以 bot 補滿（0 表示不放 bot） */
  botFill: number;
  seed?: number;
  /** 覆寫模式設定（測試用：縮短時間或降低分數上限） */
  modeOverrides?: Partial<GameModeConfig>;
  warmupSeconds?: number;
  resultSeconds?: number;
  onMatchEnd?: (result: MatchResult) => void;
}

export interface MatchResult {
  mapId: string;
  mode: string;
  winner: TeamName | 'draw';
  scores: { alpha: number; bravo: number };
  durationSeconds: number;
  players: Array<{ guestId: string; name: string; team: TeamName; bot: boolean } & ServerPlayer['stats']>;
}

export interface MatchCounters {
  shots: number;
  hits: number;
  kills: number;
  rejectedInputs: number;
  suspicious: number;
}

const REVIVE_RANGE = 2.2;
const ASSIST_WINDOW = 10;
const ASSIST_MIN_DAMAGE = 20;
const GIVE_UP_SECONDS = 1;
/** 每個玩家每 tick 增加 1 個輸入處理額度，最多累積 8 個（處理網路抖動造成的成批輸入） */
const INPUT_BUDGET_MAX = 8;
/** 超過這麼多 tick 沒有輸入，才以閒置輸入推進（例如分頁被隱藏） */
const STARVATION_TICKS = 15;

/**
 * 一場對戰的權威遊戲邏輯，不依賴 Colyseus（可直接單元測試）。
 * MatchRoom 負責把網路訊息轉給這個類別、把快照與事件送出去。
 */
export class Match {
  readonly sim: SimWorld;
  readonly manifest: MapManifest;
  readonly mode: ModeRules;
  readonly modeConfig: GameModeConfig;
  readonly matchSeed: number;
  readonly players = new Map<number, ServerPlayer>();
  readonly counters: MatchCounters = { shots: 0, hits: 0, kills: 0, rejectedInputs: 0, suspicious: 0 };
  tick = 0;
  phase: MatchPhase = 'warmup';
  winner: TeamName | 'draw' | null = null;
  private phaseEndsAt: number;
  private matchStartedAt = 0;
  private nextNumber = 1;
  private nextGrenadeId = 1;
  private readonly grenades: Grenade[] = [];
  private readonly lagComp = new LagCompensation();
  private readonly bots = new Map<number, BotBrain>();
  private readonly random: () => number;
  private broadcastEvents: GameEvent[] = [];
  private privateEvents = new Map<number, GameEvent[]>();
  private botCounter = 0;
  private readonly warmupSeconds: number;
  private readonly resultSeconds: number;

  constructor(private readonly options: MatchOptions) {
    this.manifest = options.map.manifest;
    this.sim = new SimWorld(options.map.manifest, options.map.collision, TICK_SECONDS);
    this.modeConfig = { ...getMode(options.mode), ...options.modeOverrides } as GameModeConfig;
    this.mode = createMode(this.modeConfig, this.manifest.objectives);
    this.matchSeed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.random = createRng(this.matchSeed ^ 0x5bd1e995);
    this.warmupSeconds = options.warmupSeconds ?? MATCH_LIMITS.warmupSeconds;
    this.resultSeconds = options.resultSeconds ?? MATCH_LIMITS.resultSeconds;
    this.phaseEndsAt = this.warmupSeconds;
    this.maintainBots();
  }

  get time(): number {
    return this.tick * TICK_SECONDS;
  }

  get humanCount(): number {
    return [...this.players.values()].filter((p) => !p.bot).length;
  }

  get downedEnabled(): boolean {
    return this.modeConfig.downedEnabled;
  }

  // ---------------------------------------------------------------------------
  // 玩家管理

  teamCounts(): { alpha: number; bravo: number } {
    const counts = { alpha: 0, bravo: 0 };
    for (const p of this.players.values()) {
      counts[p.team]++;
    }
    return counts;
  }

  /** 加入玩家：分到人數較少的隊伍；隊伍已滿時讓出一個 bot 的位置。 */
  addPlayer(input: { guestId: string; name: string; sessionId: string | null; bot?: boolean; team?: TeamName; loadout?: Partial<Loadout> }): ServerPlayer {
    const counts = this.teamCounts();
    let team: TeamName = input.team ?? (counts.alpha <= counts.bravo ? 'alpha' : 'bravo');
    if (counts[team] >= MATCH_LIMITS.maxPerTeam) {
      team = otherTeam(team);
    }
    if (!input.bot) {
      if (counts[team] >= MATCH_LIMITS.maxPerTeam || this.players.size >= MATCH_LIMITS.maxPlayers) {
        this.removeOneBot(team);
      }
    }
    const player = new ServerPlayer(this.nextNumber++, input.guestId, input.name, team, input.bot ?? false, input.sessionId, this.time, input.loadout);
    this.players.set(player.number, player);
    player.respawnAt = this.time;
    if (player.bot) {
      player.deployRequested = true;
      this.bots.set(player.number, new BotBrain(player.number, this.random));
    }
    if (!player.bot) {
      this.maintainBots();
    }
    return player;
  }

  removePlayer(number: number): void {
    const player = this.players.get(number);
    if (!player) {
      return;
    }
    player.dispose();
    this.players.delete(number);
    this.bots.delete(number);
    this.maintainBots();
  }

  findByGuest(guestId: string): ServerPlayer | undefined {
    return [...this.players.values()].find((p) => p.guestId === guestId && !p.bot);
  }

  findBySession(sessionId: string): ServerPlayer | undefined {
    return [...this.players.values()].find((p) => p.sessionId === sessionId);
  }

  /** 斷線：保留位置，角色移出模擬。重連時恢復。 */
  setConnected(number: number, connected: boolean, sessionId?: string): void {
    const player = this.players.get(number);
    if (!player) {
      return;
    }
    player.connected = connected;
    if (sessionId) {
      player.sessionId = sessionId;
    }
    if (!connected) {
      if (player.spawned) {
        player.health.kill();
        player.markDead(this.time, this.modeConfig.respawnSeconds);
      }
      player.inputs.clear();
    }
  }

  pushInput(number: number, frame: InputFrame): boolean {
    const player = this.players.get(number);
    const clean = sanitizeFrame(frame);
    if (!player || !clean) {
      this.counters.rejectedInputs++;
      return false;
    }
    const accepted = player.inputs.push(clean);
    if (!accepted) {
      this.counters.rejectedInputs++;
    }
    return accepted;
  }

  setLoadout(number: number, loadout: Partial<Loadout>): void {
    this.players.get(number)?.setLoadout(loadout);
  }

  /** 換隊：換完後兩隊人數差不能超過 1；新隊伍有 bot 時讓 bot 讓位。 */
  requestTeam(number: number, team: TeamName): boolean {
    const player = this.players.get(number);
    if (!player || player.team === team) {
      return false;
    }
    const after = this.teamCounts();
    after[player.team]--;
    after[team]++;
    if (after[team] > MATCH_LIMITS.maxPerTeam || after[team] - after[otherTeam(team)] > 1) {
      if (!this.removeOneBot(team)) {
        return false;
      }
    }
    if (player.spawned) {
      player.health.kill();
      player.markDead(this.time, 0);
    }
    player.team = team;
    this.maintainBots();
    return true;
  }

  deploy(number: number, spawn: string): void {
    const player = this.players.get(number);
    if (!player || player.spawned) {
      return;
    }
    player.deployRequested = true;
    player.deploySpawn = spawn;
  }

  private hasBot(team: TeamName): boolean {
    return [...this.players.values()].some((p) => p.bot && p.team === team);
  }

  private removeOneBot(team: TeamName): boolean {
    const bot = [...this.players.values()].reverse().find((p) => p.bot && p.team === team);
    if (!bot) {
      return false;
    }
    bot.dispose();
    this.players.delete(bot.number);
    this.bots.delete(bot.number);
    return true;
  }

  /** 依 botFill 補滿或移除 bot，維持兩隊人數平衡。 */
  maintainBots(): void {
    const target = Math.min(this.options.botFill, MATCH_LIMITS.maxPlayers);
    let guard = 0;
    while (this.players.size < target && guard++ < 32) {
      const counts = this.teamCounts();
      const team: TeamName = counts.alpha <= counts.bravo ? 'alpha' : 'bravo';
      if (counts[team] >= MATCH_LIMITS.maxPerTeam) {
        break;
      }
      this.botCounter++;
      this.addPlayer({ guestId: `bot-${this.botCounter}`, name: `Bot ${this.botCounter}`, sessionId: null, bot: true, team, loadout: this.randomBotLoadout() });
    }
    guard = 0;
    while (this.players.size > target && (this.hasBot('alpha') || this.hasBot('bravo'))) {
      const counts = this.teamCounts();
      const bigger: TeamName = counts.alpha >= counts.bravo ? 'alpha' : 'bravo';
      if (!this.removeOneBot(bigger) && !this.removeOneBot(otherTeam(bigger))) {
        break;
      }
      if (guard++ > 32) {
        break;
      }
    }
    // 兩隊差距超過 1 時，把 bot 換到人少的一隊
    const counts = this.teamCounts();
    const bigger: TeamName = counts.alpha > counts.bravo ? 'alpha' : 'bravo';
    if (Math.abs(counts.alpha - counts.bravo) > 1) {
      const bot = [...this.players.values()].find((p) => p.bot && p.team === bigger);
      if (bot) {
        bot.team = otherTeam(bigger);
        if (bot.spawned) {
          bot.health.kill();
          bot.markDead(this.time, 1);
        }
      }
    }
  }

  private randomBotLoadout(): Partial<Loadout> {
    const classes = ['assault', 'medic', 'support', 'recon'];
    return { classId: classes[Math.floor(this.random() * classes.length)]! };
  }

  // ---------------------------------------------------------------------------
  // 主迴圈

  step(): void {
    this.tick++;
    const now = this.time;
    const dt = TICK_SECONDS;

    for (const [number, brain] of this.bots) {
      const bot = this.players.get(number);
      if (bot) {
        const frame = brain.think(this, bot, now);
        if (frame) {
          bot.inputs.push(frame);
        }
      }
    }

    for (const player of this.players.values()) {
      if (!player.connected) {
        continue;
      }
      // 每個輸入框只處理一次、依序處理：與客戶端預測完全一致。
      // 額度每 tick 補 1，送得比 30 Hz 快的客戶端不會被處理得更快（防加速）。
      player.inputBudget = Math.min(INPUT_BUDGET_MAX, player.inputBudget + 1);
      let processed = 0;
      while (player.inputBudget >= 1 && player.inputs.pending > 0) {
        const frame = player.inputs.take()!;
        player.inputBudget--;
        processed++;
        player.lastFrame = frame;
        if (player.spawned) {
          this.stepPlayer(player, frame, now, dt);
        }
      }
      if (processed === 0) {
        player.starvedTicks++;
        if (player.starvedTicks > STARVATION_TICKS && player.spawned) {
          const idle = player.inputs.next().frame;
          player.lastFrame = idle;
          this.stepPlayer(player, idle, now, dt);
        }
      } else {
        player.starvedTicks = 0;
      }
      if (!player.bot && player.inputs.overflow > 30) {
        player.suspicious++;
        this.counters.suspicious++;
        player.inputs.overflow = 0;
      }
    }
    this.sim.step();

    this.stepGrenades(now, dt);
    this.stepHealthAndAreas(now, dt);
    this.stepMode(now, dt);
    this.stepRespawns(now);
    this.recordHistory();
  }

  private stepPlayer(player: ServerPlayer, frame: InputFrame, now: number, dt: number): void {
    const body = player.body!;
    if (player.health.state === 'downed') {
      // 倒地：不能移動或開火，按住放棄 1 秒後死亡
      player.giveUpHeld = has(frame, BUTTON.giveUp) ? player.giveUpHeld + dt : 0;
      body.step({ move: { forward: 0, right: 0, sprint: false }, jump: false, stance: 'prone', aim: false }, frame.y, dt);
      if (player.giveUpHeld >= GIVE_UP_SECONDS) {
        this.finalizeDeath(player, null, 'giveUp');
      }
      return;
    }
    body.speedScale = waterSpeedScale(waterDepthAt(this.manifest, body.position)) * player.classDef.sprintMultiplier;
    const input = characterInputFrom(frame);
    const sprintingBefore = body.snapshot().locomotion === 'sprinting';
    body.step(input, frame.y, dt);
    const after = body.snapshot();
    player.weaponClock += dt;

    // 切換武器
    if (frame.w !== player.slot && player.weapons[frame.w]) {
      player.currentWeapon?.holster();
      player.slot = frame.w;
      player.currentWeapon!.equip(player.weaponClock);
    }
    const weapon = player.currentWeapon;
    if (weapon) {
      const sprinting = after.locomotion === 'sprinting';
      const events = weapon.update(player.weaponClock, dt, weaponInputFrom(frame, !sprinting));
      for (const event of events) {
        if (event.type === 'shot') {
          this.fireShot(player, frame, event, sprintingBefore);
        }
      }
    }

    // 手榴彈
    if (has(frame, BUTTON.grenade) && player.grenades > 0 && now - player.lastThrowAt >= 1) {
      player.grenades--;
      player.lastThrowAt = now;
      const dir = directionFromYawPitch(frame.y, Math.min(1.2, frame.p + 0.12));
      const eye = { x: after.feet.x, y: after.feet.y + eyeHeight(after.stance), z: after.feet.z };
      const origin = { x: eye.x + dir.x * 0.5, y: eye.y + dir.y * 0.5, z: eye.z + dir.z * 0.5 };
      this.grenades.push(createGrenade(this.nextGrenadeId++, player.number, player.classDef.grenade.id, origin, dir, after.velocity, now));
    }

    // 兵種技能
    if (has(frame, BUTTON.ability) && now >= player.abilityReadyAt) {
      if (this.useAbility(player, frame, now)) {
        player.abilityReadyAt = now + player.classDef.ability.cooldownSeconds;
      }
    }

    // 救援（按住互動）
    if (has(frame, BUTTON.interact)) {
      this.stepRevive(player, dt, now);
    } else {
      player.reviveTarget = null;
      player.reviveProgress = 0;
    }

    if (after.feet.y < this.manifest.killPlaneY) {
      player.health.kill();
      this.finalizeDeath(player, null, 'fall');
    }
  }

  // ---------------------------------------------------------------------------
  // 開火與命中

  private fireShot(player: ServerPlayer, frame: InputFrame, shot: Extract<WeaponEvent, { type: 'shot' }>, sprintingBefore: boolean): void {
    const body = player.body!;
    const weapon = player.currentWeapon!;
    const def = weapon.def;
    const s = body.snapshot();
    const origin = { x: s.feet.x, y: s.feet.y + eyeHeight(s.stance), z: s.feet.z };
    const aim = directionFromYawPitch(frame.y, frame.p);
    const spread = spreadDegrees(def, {
      aiming: has(frame, BUTTON.aim) && s.locomotion !== 'sprinting',
      stance: s.stance,
      moving: Math.hypot(s.velocity.x, s.velocity.z) > 0.5,
      airborne: !s.grounded,
      bloom: shot.bloom,
    });
    void sprintingBefore;
    const seed = shotSeed(this.matchSeed, player.number, player.slot, shot.shotSeq);
    const directions = pelletDirections(def, aim, spread, seed);
    // 延遲補償：用客戶端畫面上的 tick（vt）回溯其他玩家位置；bot 直接用目前 tick
    const rewound = this.lagComp.posesAt(player.bot ? this.tick : frame.vt, this.tick);
    const ends: Array<[number, number, number]> = [];
    let firstMaterial = 'default';
    this.counters.shots++;
    directions.forEach((dir, index) => {
      const range = def.damage.maxRangeMeters;
      const world = this.sim.castBullet(origin, dir, range);
      let maxDistance = world ? world.distance : range;
      let victim: { number: number; zone: HitZone; distance: number } | null = null;
      for (const [number, pose] of rewound?.poses ?? []) {
        if (number === player.number || !pose.hittable) {
          continue;
        }
        const hit = raycastHitbox(pose, origin, dir, maxDistance);
        if (hit && hit.distance < maxDistance) {
          maxDistance = hit.distance;
          victim = { number, zone: hit.zone, distance: hit.distance };
        }
      }
      const end: [number, number, number] = [origin.x + dir.x * maxDistance, origin.y + dir.y * maxDistance, origin.z + dir.z * maxDistance];
      ends.push(end.map((v) => Math.round(v * 100) / 100) as [number, number, number]);
      if (index === 0) {
        firstMaterial = victim ? 'flesh' : (world?.material ?? 'default');
      }
      if (victim) {
        const target = this.players.get(victim.number);
        if (target?.spawned) {
          const amount = damageAtDistance(def, victim.distance) * zoneMultiplier(def, victim.zone);
          this.applyDamage(target, amount, player, def.displayName, victim.zone, origin);
        }
      }
    });
    this.broadcastEvents.push({
      k: 'shot',
      p: player.number,
      o: [origin.x, origin.y, origin.z].map((v) => Math.round(v * 100) / 100) as [number, number, number],
      e: ends,
      m: firstMaterial,
      w: def.id,
    });
  }

  /** 套用傷害：友傷規則、倒地與死亡、擊殺與助攻計算、事件。 */
  applyDamage(target: ServerPlayer, amount: number, attacker: ServerPlayer | null, weaponName: string, zone: HitZone | 'explosion', from: Vec3): void {
    if (this.phase !== 'active' || amount <= 0 || !target.spawned) {
      return;
    }
    const friendly = attacker && attacker !== target && attacker.team === target.team;
    if (friendly && !this.modeConfig.friendlyFire) {
      return;
    }
    const now = this.time;
    if (attacker && attacker !== target) {
      const entry = target.damageLog.get(attacker.number);
      target.damageLog.set(attacker.number, { amount: (entry && now - entry.at < ASSIST_WINDOW ? entry.amount : 0) + amount, at: now });
    }
    const wasDowned = target.health.state === 'downed';
    const transition = target.health.damage(amount, now);
    this.counters.hits++;
    if (attacker && attacker !== target) {
      this.pushPrivate(attacker.number, { k: 'hit', target: target.number, zone, damage: Math.round(amount), kill: transition !== null && !wasDowned });
    }
    this.pushPrivate(target.number, { k: 'damaged', from: [from.x, from.y, from.z], amount: Math.round(amount) });
    if (transition === 'downed' || (transition === 'dead' && !wasDowned)) {
      this.creditKill(target, attacker, weaponName, zone === 'head');
    }
    if (transition === 'dead') {
      this.finalizeDeath(target, attacker, weaponName);
    }
  }

  private creditKill(victim: ServerPlayer, killer: ServerPlayer | null, weaponName: string, headshot: boolean): void {
    if (victim.killCredited) {
      return;
    }
    victim.killCredited = true;
    this.counters.kills++;
    const now = this.time;
    const validKiller = killer && killer !== victim && killer.team !== victim.team ? killer : null;
    if (validKiller) {
      validKiller.stats.kills++;
      validKiller.stats.score += 100;
    }
    for (const [number, entry] of victim.damageLog) {
      if (number === killer?.number || now - entry.at > ASSIST_WINDOW || entry.amount < ASSIST_MIN_DAMAGE) {
        continue;
      }
      const helper = this.players.get(number);
      if (helper && helper.team !== victim.team) {
        helper.stats.assists++;
        helper.stats.score += 50;
      }
    }
    this.mode.onKill(validKiller?.team ?? null, victim.team);
    this.broadcastEvents.push({
      k: 'kill',
      killer: killer?.number ?? null,
      killerName: killer?.name ?? '',
      killerTeam: killer?.team ?? null,
      victim: victim.number,
      victimName: victim.name,
      victimTeam: victim.team,
      weapon: weaponName,
      headshot,
    });
  }

  /** 真正死亡（不含倒地）：扣票、排定重生。 */
  private finalizeDeath(player: ServerPlayer, killer: ServerPlayer | null, cause: string): void {
    if (player.health.state !== 'dead') {
      player.health.kill();
    }
    if (!player.killCredited) {
      this.creditKill(player, killer, cause === 'giveUp' ? '放棄' : cause === 'restricted' ? '禁區' : cause === 'fall' ? '墜落' : cause, false);
    }
    player.stats.deaths++;
    player.markDead(this.time, this.modeConfig.respawnSeconds);
    if (this.phase === 'active') {
      this.mode.onDeath(player.team);
    }
  }

  // ---------------------------------------------------------------------------
  // 技能與救援

  private useAbility(player: ServerPlayer, frame: InputFrame, now: number): boolean {
    const ability = player.classDef.ability;
    const at = player.body!.position;
    const teammatesWithin = (radius: number) =>
      [...this.players.values()].filter((p) => p.team === player.team && p.alive && Math.hypot(p.body!.position.x - at.x, p.body!.position.z - at.z) <= radius);
    let used = false;
    switch (ability.kind) {
      case 'stim':
        if (player.health.health < player.health.config.maxHealth) {
          player.health.heal(ability.healAmount);
          used = true;
        }
        break;
      case 'healPulse':
        for (const p of teammatesWithin(ability.radius)) {
          p.health.heal(ability.healAmount);
        }
        used = true;
        break;
      case 'resupply':
        for (const p of teammatesWithin(ability.radius)) {
          for (const w of p.weapons) {
            w.refill();
          }
          p.grenades = p.classDef.grenade.count;
        }
        used = true;
        break;
      case 'spot': {
        const eye = { x: at.x, y: at.y + eyeHeight(player.body!.currentStance), z: at.z };
        const forward = directionFromYawPitch(frame.y, frame.p);
        const cos = Math.cos((ability.coneHalfAngleDegrees * Math.PI) / 180);
        for (const enemy of this.players.values()) {
          if (enemy.team === player.team || !enemy.spawned) {
            continue;
          }
          const chest = { x: enemy.body!.position.x, y: enemy.body!.position.y + 1.1, z: enemy.body!.position.z };
          const d = { x: chest.x - eye.x, y: chest.y - eye.y, z: chest.z - eye.z };
          const dist = Math.hypot(d.x, d.y, d.z);
          if (dist > ability.range || (d.x * forward.x + d.y * forward.y + d.z * forward.z) / dist < cos) {
            continue;
          }
          if (this.sim.lineOfSight(eye, chest)) {
            enemy.spottedUntil = now + ability.durationSeconds;
          }
        }
        used = true;
        break;
      }
    }
    if (used) {
      this.broadcastEvents.push({ k: 'ability', p: player.number, kind: ability.kind, at: [at.x, at.y, at.z] });
    }
    return used;
  }

  private stepRevive(player: ServerPlayer, dt: number, now: number): void {
    const at = player.body!.position;
    let target = player.reviveTarget !== null ? this.players.get(player.reviveTarget) : undefined;
    if (!target || target.health.state !== 'downed' || Math.hypot(target.body!.position.x - at.x, target.body!.position.z - at.z) > REVIVE_RANGE * 1.25) {
      target = [...this.players.values()]
        .filter((p) => p !== player && p.team === player.team && p.health.state === 'downed' && p.body)
        .sort((a, b) => Math.hypot(a.body!.position.x - at.x, a.body!.position.z - at.z) - Math.hypot(b.body!.position.x - at.x, b.body!.position.z - at.z))
        .find((p) => Math.hypot(p.body!.position.x - at.x, p.body!.position.z - at.z) <= REVIVE_RANGE);
      player.reviveProgress = 0;
    }
    if (!target) {
      player.reviveTarget = null;
      player.reviveProgress = 0;
      return;
    }
    player.reviveTarget = target.number;
    player.reviveProgress += dt / Math.max(0.1, player.classDef.reviveSeconds);
    if (player.reviveProgress >= 1) {
      target.health.revive(player.classDef.reviveHealthFraction, now);
      target.killCredited = false;
      target.damageLog.clear();
      player.stats.revives++;
      player.stats.score += 50;
      player.reviveTarget = null;
      player.reviveProgress = 0;
      this.broadcastEvents.push({ k: 'revived', p: target.number, by: player.number });
    }
  }

  // ---------------------------------------------------------------------------
  // 手榴彈、血量、禁區、模式、重生

  private stepGrenades(now: number, dt: number): void {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i]!;
      stepGrenade(g, this.sim, dt);
      if (now < g.explodeAt) {
        continue;
      }
      this.grenades.splice(i, 1);
      const owner = this.players.get(g.owner) ?? null;
      const point = { x: g.position.x, y: g.position.y + 0.3, z: g.position.z };
      for (const target of this.players.values()) {
        if (!target.spawned) {
          continue;
        }
        const chest = { x: target.body!.position.x, y: target.body!.position.y + 0.9, z: target.body!.position.z };
        const distance = Math.hypot(chest.x - point.x, chest.y - point.y, chest.z - point.z);
        if (distance > g.def.outerRadius || !this.sim.lineOfSight(point, chest)) {
          continue;
        }
        this.applyDamage(target, explosionDamage(g.def, distance), owner, g.def.displayName, 'explosion', point);
      }
      this.broadcastEvents.push({ k: 'explosion', p: [point.x, point.y, point.z] });
    }
  }

  private stepHealthAndAreas(now: number, dt: number): void {
    for (const player of this.players.values()) {
      if (!player.spawned) {
        continue;
      }
      const transition = player.health.tick(now, dt);
      if (transition === 'dead') {
        this.finalizeDeath(player, null, 'bleedout');
        continue;
      }
      if (player.health.state !== 'alive') {
        continue;
      }
      const feet = player.body!.position;
      const b = this.manifest.bounds;
      const outside = feet.x < b.min[0] || feet.x > b.max[0] || feet.z < b.min[2] || feet.z > b.max[2];
      const area = this.manifest.restrictedAreas.find((a) => (a.team === undefined || a.team === player.team) && pointInBounds(feet, a.bounds));
      if (outside || area) {
        player.restrictedTime += dt;
        const grace = area?.graceSeconds ?? 5;
        if (player.restrictedTime >= grace) {
          player.health.kill();
          this.finalizeDeath(player, null, 'restricted');
        }
      } else {
        player.restrictedTime = 0;
      }
    }
  }

  private stepMode(now: number, dt: number): void {
    if (this.phase === 'warmup') {
      if (now >= this.phaseEndsAt) {
        this.phase = 'active';
        this.matchStartedAt = now;
        this.phaseEndsAt = now + this.modeConfig.timeLimitSeconds;
        this.broadcastEvents.push({ k: 'message', text: '對戰開始！' });
      }
      return;
    }
    if (this.phase === 'ended') {
      if (now >= this.phaseEndsAt) {
        this.resetMatch();
      }
      return;
    }
    const occupants = [...this.players.values()]
      .filter((p) => p.alive)
      .map((p) => ({ number: p.number, team: p.team, feet: p.body!.position }));
    const result = this.mode.tick({ dt, occupants });
    for (const capture of result.captured) {
      this.broadcastEvents.push({ k: 'captured', id: capture.id, team: capture.team });
      for (const number of capture.capturers) {
        const p = this.players.get(number);
        if (p && capture.team) {
          p.stats.captures++;
          p.stats.score += 200;
        }
      }
    }
    const winner = this.mode.winner(now >= this.phaseEndsAt);
    if (winner) {
      this.endMatch(winner);
    }
  }

  private endMatch(winner: TeamName | 'draw'): void {
    this.phase = 'ended';
    this.winner = winner;
    this.phaseEndsAt = this.time + this.resultSeconds;
    this.broadcastEvents.push({ k: 'message', text: winner === 'draw' ? '平手' : `${winner === 'alpha' ? 'ALPHA' : 'BRAVO'} 獲勝` });
    this.options.onMatchEnd?.({
      mapId: this.manifest.id,
      mode: this.modeConfig.id,
      winner,
      scores: this.mode.scores(),
      durationSeconds: Math.round(this.time - this.matchStartedAt),
      players: [...this.players.values()].map((p) => ({ guestId: p.guestId, name: p.name, team: p.team, bot: p.bot, ...p.stats })),
    });
  }

  /** 新一場：分數歸零、所有人重新部署。 */
  private resetMatch(): void {
    this.mode.reset();
    this.winner = null;
    this.phase = 'warmup';
    this.phaseEndsAt = this.time + this.warmupSeconds;
    this.grenades.length = 0;
    for (const p of this.players.values()) {
      Object.assign(p.stats, { kills: 0, deaths: 0, assists: 0, score: 0, revives: 0, captures: 0 });
      if (p.spawned) {
        p.health.kill();
      }
      p.health.state = 'spectating';
      p.respawnAt = this.time;
      p.deployRequested = p.bot || p.deployRequested;
    }
  }

  private stepRespawns(now: number): void {
    for (const player of this.players.values()) {
      if (player.spawned || !player.connected || !player.deployRequested || now < player.respawnAt) {
        continue;
      }
      const occupied = [...this.players.values()].filter((p) => p.spawned).map((p) => ({ position: p.body!.position, team: p.team }));
      const objective = this.mode.objectives().find((o) => o.id === player.deploySpawn && o.owner === player.team);
      const choice = chooseSpawn(
        this.manifest,
        this.sim,
        player.team,
        occupied,
        objective ? { kind: 'objective', position: objective.position, radius: objective.radius } : { kind: 'base' },
        this.random,
      );
      player.spawn(this.sim, choice.feet, choice.yaw, this.modeConfig.downedEnabled, now);
      this.broadcastEvents.push({ k: 'spawn', p: player.number });
    }
  }

  private recordHistory(): void {
    const poses = new Map<number, PoseRecord>();
    for (const p of this.players.values()) {
      if (p.body) {
        poses.set(p.number, { feet: { ...p.body.position }, yaw: p.lastFrame?.y ?? 0, stance: p.body.currentStance, hittable: p.spawned });
      }
    }
    this.lagComp.record(this.tick, poses);
  }

  // ---------------------------------------------------------------------------
  // 輸出

  private pushPrivate(number: number, event: GameEvent): void {
    const list = this.privateEvents.get(number) ?? [];
    list.push(event);
    this.privateEvents.set(number, list);
  }

  drainEvents(): { broadcast: GameEvent[]; private: Map<number, GameEvent[]> } {
    const out = { broadcast: this.broadcastEvents, private: this.privateEvents };
    this.broadcastEvents = [];
    this.privateEvents = new Map();
    return out;
  }

  remoteWire(p: ServerPlayer, now: number): RemotePlayerWire | null {
    const position = p.body?.position ?? p.lastDeathPosition;
    if (!position) {
      return null;
    }
    const s = p.body?.snapshot();
    const lifeIndex = LIFE_CODES.indexOf(p.health.state);
    const flags = (p.spottedUntil > now ? 1 : 0) | (p.connected ? 0 : 2) | (p.bot ? 4 : 0);
    const r = (v: number) => Math.round(v * 100) / 100;
    return [
      p.number,
      r(position.x),
      r(position.y),
      r(position.z),
      r(p.lastFrame?.y ?? 0),
      r(p.lastFrame?.p ?? 0),
      STANCE_CODES.indexOf(s?.stance ?? 'standing'),
      LOCOMOTION_CODES.indexOf(s?.locomotion ?? 'idle'),
      lifeIndex,
      p.team === 'alpha' ? 0 : 1,
      p.currentWeapon?.def.id ?? '',
      flags,
    ];
  }

  selfWire(p: ServerPlayer, now: number): SelfStateWire {
    const state = p.body?.getState();
    const feet = state?.feet ?? p.lastDeathPosition ?? { x: 0, y: 0, z: 0 };
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      feet: [r(feet.x), r(feet.y), r(feet.z)],
      vel: state ? [r(state.velocity.x), r(state.velocity.y), r(state.velocity.z)] : [0, 0, 0],
      int: state ? [r(state.intended.x), r(state.intended.z)] : [0, 0],
      g: state?.grounded ?? true,
      st: STANCE_CODES.indexOf(state?.stance ?? 'standing'),
      life: LIFE_CODES.indexOf(p.health.state),
      hp: Math.round(p.health.health * 10) / 10,
      maxHp: p.health.config.maxHealth,
      slot: p.slot,
      weapons: p.weapons.map((w) => ({ id: w.def.id, ammo: w.ammo, reserve: w.reserve, seq: w.shotSeq, fm: w.fireModeIndex, rl: w.reloading })),
      grenades: p.grenades,
      abilityReadyIn: Math.max(0, Math.round((p.abilityReadyAt - now) * 10) / 10),
      respawnIn: p.spawned ? 0 : Math.max(0, Math.round((p.respawnAt - now) * 10) / 10),
      bleedoutIn: p.health.state === 'downed' ? Math.max(0, p.health.bleedoutEnd - now) : 0,
      reviveProgress: p.reviveProgress,
      restrictedIn: p.restrictedTime > 0 ? Math.max(0, (this.manifest.restrictedAreas[0]?.graceSeconds ?? 5) - p.restrictedTime) : 0,
      classId: p.loadout.classId,
      spotted: p.spottedUntil > now,
    };
  }

  snapshotFor(number: number): SnapshotMessage {
    const now = this.time;
    const self = this.players.get(number);
    const players: RemotePlayerWire[] = [];
    for (const p of this.players.values()) {
      if (p.number === number) {
        continue;
      }
      const wire = this.remoteWire(p, now);
      if (wire) {
        players.push(wire);
      }
    }
    return {
      t: this.tick,
      ack: self?.inputs.ack ?? 0,
      self: self ? this.selfWire(self, now) : null,
      players,
      grenades: this.grenades.map((g) => ({ id: g.id, p: [g.position.x, g.position.y, g.position.z].map((v) => Math.round(v * 100) / 100) as [number, number, number] })),
    };
  }

  scoreboard(): ScoreboardWire[] {
    return [...this.players.values()].map((p) => ({
      n: p.number,
      name: p.name,
      team: p.team,
      kills: p.stats.kills,
      deaths: p.stats.deaths,
      assists: p.stats.assists,
      score: p.stats.score,
      ping: p.ping,
      alive: p.spawned,
      connected: p.connected,
      bot: p.bot,
      classId: p.loadout.classId,
    }));
  }

  matchState(): MatchStateMessage {
    return {
      phase: this.phase,
      timeLeft: Math.max(0, Math.round((this.phaseEndsAt - this.time) * 10) / 10),
      scores: this.mode.scores(),
      scoreLimit: this.mode.scoreLimit(),
      winner: this.winner,
      objectives: this.mode.objectives().map(({ alphaInside: _a, bravoInside: _b, ...o }) => ({ ...o, progress: Math.round(o.progress * 100) / 100 })),
      players: this.scoreboard(),
    };
  }

  /** 開發指令：把玩家放到指定位置（只有 DEV_COMMANDS=1 時由房間呼叫）。 */
  debugTeleport(number: number, feet: Vec3): void {
    const player = this.players.get(number);
    if (player?.body && player.spawned) {
      player.body.teleport(feet);
      player.inputs.clear();
    }
  }

  /** 讓 phase 立即進入 active（測試與「略過暖身」用）。 */
  skipWarmup(): void {
    if (this.phase === 'warmup') {
      this.phaseEndsAt = this.time;
    }
  }

  dispose(): void {
    for (const p of this.players.values()) {
      p.dispose();
    }
    this.players.clear();
    this.sim.dispose();
  }
}

export function guestNumberSeed(guestId: string): number {
  return hashString(guestId);
}

export { TICK_RATE };
