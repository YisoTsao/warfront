import { findWeapon, getWeapon, sanitizeLoadout, type Loadout } from '@frontline/game-config';
import {
  BUTTON,
  INTERPOLATION_DELAY_SECONDS,
  LIFE_CODES,
  STANCE_CODES,
  TICK_RATE,
  type EventsMessage,
  type GameEvent,
  type InputFrame,
  type LifeState,
  type MatchStateMessage,
  type SnapshotMessage,
  type TeamName,
  type WelcomeMessage,
} from '@frontline/shared';
import { characterInputFrom, type CharacterState } from '@frontline/simulation';
import * as THREE from 'three';
import type { FrontlineDebugHook } from '../debug/debugHook';
import type { KillFeedEntry, ScoreboardRow } from '../hud/HudStore';
import type { MapMarker } from '../hud/TacticalMap';
import type { SimulationInput } from '../input/InputManager';
import { ColyseusTransport } from '../network/ColyseusTransport';
import type { ConnectionState, GameTransport, JoinRequest, TransportHandlers } from '../network/GameTransport';
import { RemotePlayers } from '../remote/RemotePlayers';
import { LocalArsenal } from '../weapons/LocalArsenal';
import type { PelletResolver } from '../weapons/WeaponController';
import { GameBase, createGameParts, type GameBaseOptions, type GameParts } from './GameBase';

export interface OnlineOptions extends Omit<GameBaseOptions, 'mapId' | 'matchSeed' | 'playerNumber'> {
  join: JoinRequest;
  transport?: GameTransport;
}

interface Pending {
  seq: number;
  frame: InputFrame;
  state: CharacterState;
  weapon: { slot: number; ammo: number; reserve: number; shotSeq: number };
}

const RECONCILE_THRESHOLD = 0.03;
const PING_INTERVAL = 2;

/**
 * 連線對戰：本機玩家以客戶端預測立即反應，收到伺服器快照後比對並修正
 * （回到伺服器狀態、重播尚未確認的輸入）；遠端玩家以快照插值顯示。
 * 傷害、彈藥、擊殺與分數一律以伺服器為準。
 */
export class OnlineGame extends GameBase {
  private seq = 0;
  private pending: Pending[] = [];
  private life: LifeState = 'spectating';
  private spawnedLocally = false;
  private deathAt = 0;
  private lastSnapshotTick = 0;
  private lastSnapshotAt = 0;
  private rtt = 0;
  private pingTimer = 0;
  private corrections = 0;
  private killFeed: KillFeedEntry[] = [];
  private killFeedId = 0;
  private damageSerial = 0;
  private messageTimer = 0;
  private team: TeamName;
  private readonly grenades = new Map<number, THREE.Mesh>();
  private readonly grenadeGeometry = new THREE.SphereGeometry(0.06, 8, 8);
  private readonly grenadeMaterial = new THREE.MeshStandardMaterial({ color: 0x3a4030, roughness: 0.7 });
  private matchState: MatchStateMessage | null = null;
  private confirmed = { hits: 0, kills: 0, headshots: 0 };
  private connection: ConnectionState = 'connected';

  private constructor(
    parts: GameParts,
    private readonly transport: GameTransport,
    private readonly remotes: RemotePlayers,
    private readonly welcome: WelcomeMessage,
  ) {
    super(parts);
    this.team = welcome.team;
    this.remotes.myTeam = welcome.team;
    this.lastSnapshotTick = welcome.serverTick;
    this.lastSnapshotAt = performance.now();
    this.hud.set({ mode: welcome.mode, phase: 'warmup', team: welcome.team, connection: 'connected', lifeState: 'dead', respawnIn: 0 });
  }

  static async create(container: HTMLElement, options: OnlineOptions): Promise<OnlineGame> {
    const transport = options.transport ?? new ColyseusTransport();
    const target: { game: OnlineGame | null; welcome: WelcomeMessage | null; queue: Array<() => void> } = { game: null, welcome: null, queue: [] };
    let resolveWelcome: (w: WelcomeMessage) => void = () => undefined;
    const welcomed = new Promise<WelcomeMessage>((resolve) => {
      resolveWelcome = resolve;
    });
    const dispatch = (fn: (game: OnlineGame) => void) => {
      if (target.game) {
        fn(target.game);
      }
    };
    const handlers: TransportHandlers = {
      onWelcome: (w) => {
        if (!target.welcome) {
          target.welcome = w;
          resolveWelcome(w);
        } else {
          dispatch((g) => g.onWelcome(w));
        }
      },
      onSnapshot: (s) => dispatch((g) => g.applySnapshot(s)),
      onEvents: (e) => dispatch((g) => g.handleEvents(e)),
      onMatchState: (m) => {
        if (target.game) {
          target.game.applyMatchState(m);
        } else {
          target.queue.push(() => target.game?.applyMatchState(m));
        }
      },
      onPong: (p) => dispatch((g) => g.onPong(p)),
      onError: (message) => dispatch((g) => g.flashMessage(message)),
      onConnectionChange: (state, detail) => dispatch((g) => g.onConnectionChange(state, detail)),
    };
    await transport.connect(options.join, handlers);
    const welcome = await Promise.race([
      welcomed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('伺服器沒有回應（逾時）')), 15_000)),
    ]);
    const holder: { remotes: RemotePlayers | null } = { remotes: null };
    let parts: GameParts;
    try {
      parts = await createGameParts(
        container,
        { ...options, mapId: welcome.mapId, matchSeed: welcome.matchSeed, playerNumber: welcome.playerNumber },
        (p) => {
          holder.remotes = new RemotePlayers(p.renderer.scene, p.map.sim, p.audio);
          return OnlineGame.predictedResolver(p.map.sim, holder.remotes, welcome.team);
        },
      );
    } catch (error) {
      await transport.leave();
      throw error;
    }
    const game = new OnlineGame(parts, transport, holder.remotes!, welcome);
    target.game = game;
    for (const fn of target.queue) {
      fn();
    }
    game.applySettings(options.settings);
    if (options.loadout) {
      transport.sendLoadout(options.loadout);
    }
    return game;
  }

  /** 預測用：只決定特效（打到牆或人），不扣血。 */
  private static predictedResolver(sim: GameParts['map']['sim'], remotes: RemotePlayers, team: TeamName): PelletResolver {
    return {
      resolve(weapon, origin, direction) {
        const range = weapon.damage.maxRangeMeters;
        const world = sim.castBullet(origin, direction, range);
        const max = world ? world.distance : range;
        const hit = remotes.raycast(origin, direction, max, team);
        if (hit) {
          return {
            end: { x: origin.x + direction.x * hit.distance, y: origin.y + direction.y * hit.distance, z: origin.z + direction.z * hit.distance },
            normal: null,
            material: 'flesh',
            target: { zone: hit.zone, killed: false },
          };
        }
        if (world) {
          return { end: world.point, normal: world.normal, material: world.material, target: null };
        }
        return { end: { x: origin.x + direction.x * range, y: origin.y + direction.y * range, z: origin.z + direction.z * range }, normal: null, material: 'default', target: null };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 給 UI 使用

  /** 部署：送出配裝與出生點，伺服器在重生時間到後出生。 */
  deploy(loadout: Partial<Loadout>, spawn: string): void {
    this.transport.sendLoadout(sanitizeLoadout(loadout));
    this.transport.sendDeploy({ spawn });
  }

  requestTeam(team: TeamName): void {
    this.transport.sendTeam(team);
  }

  async leave(): Promise<void> {
    await this.transport.leave();
  }

  get isAlive(): boolean {
    return this.life === 'alive';
  }

  get currentTeam(): TeamName {
    return this.team;
  }

  get state(): MatchStateMessage | null {
    return this.matchState;
  }

  // ---------------------------------------------------------------------------
  // 模擬

  private estimatedServerTick(): number {
    const elapsed = (performance.now() - this.lastSnapshotAt) / 1000;
    return this.lastSnapshotTick + Math.min(6, elapsed * TICK_RATE);
  }

  private renderTick(): number {
    return this.estimatedServerTick() - INTERPOLATION_DELAY_SECONDS * TICK_RATE;
  }

  protected simulateStep(dt: number, input: SimulationInput): void {
    if (this.life === 'downed') {
      // 倒地：只能放棄（按住 X）
      this.seq++;
      const frame: InputFrame = {
        s: this.seq,
        f: 0,
        r: 0,
        b: input.held.has('giveUp') ? BUTTON.giveUp : 0,
        st: 2,
        y: this.cameraRig.yaw,
        p: this.cameraRig.pitch,
        w: this.weapons.arsenal.slot,
        vt: Math.round(this.renderTick()),
      };
      this.transport.sendInput([frame]);
      return;
    }
    if (!this.spawnedLocally || this.life !== 'alive') {
      return;
    }
    if (input.held.has('fire')) {
      input.move.sprint = false;
    }
    const characterInput = this.player.buildInput(input, input.held.has('aim'));
    const arsenal = this.weapons.arsenal;
    const desiredSlot = arsenal.requestedSlot(input.pressed) ?? arsenal.slot;
    const flags = {
      sprint: characterInput.move.sprint,
      jump: characterInput.jump,
      aim: input.held.has('aim'),
      fire: input.held.has('fire'),
      reload: input.pressed.has('reload'),
      fireMode: input.pressed.has('fireMode'),
      grenade: input.pressed.has('grenade'),
      ability: input.pressed.has('ability'),
      interact: input.held.has('interact'),
      giveUp: input.held.has('giveUp'),
    };
    let b = 0;
    for (const [name, on] of Object.entries(flags) as Array<[keyof typeof BUTTON, boolean]>) {
      if (on) {
        b |= BUTTON[name];
      }
    }
    this.seq++;
    const frame: InputFrame = {
      s: this.seq,
      f: characterInput.move.forward,
      r: characterInput.move.right,
      b,
      st: STANCE_CODES.indexOf(characterInput.stance),
      y: this.cameraRig.yaw,
      p: this.cameraRig.pitch,
      w: desiredSlot,
      vt: Math.round(this.renderTick()),
    };
    // 預測：與伺服器使用同一個輸入轉換
    const before = this.player.snapshot();
    this.player.step(characterInputFrom(frame), frame.y, dt);
    this.map.sim.step();
    this.simTime += dt;
    const after = this.player.snapshot();
    this.weapons.step(this.simTime, dt, input, after, frame.y, frame.p, true);
    const step = this.footsteps.step(after.feet, before.feet, after.locomotion, after.stance, after.grounded);
    if (step) {
      this.audio.footstep(null, step.surface, step.loudness * 0.6);
    }
    if (flags.grenade && this.hud.get().grenades > 0) {
      this.audio.reloadStep('charge');
    }
    this.recordStep();
    const w = arsenal.current;
    this.pending.push({ seq: frame.s, frame, state: this.player.body.getState(), weapon: { slot: arsenal.slot, ammo: w.ammo, reserve: w.reserve, shotSeq: w.shotSeq } });
    if (this.pending.length > 120) {
      this.pending.shift();
    }
    this.transport.sendInput([frame]);
  }

  protected onFrame(frameSeconds: number): void {
    const renderTick = this.renderTick();
    this.remotes.update(renderTick, frameSeconds, this.renderer.camera.position);
    for (const mesh of this.grenades.values()) {
      const target = mesh.userData.target as THREE.Vector3;
      mesh.position.lerp(target, Math.min(1, frameSeconds * 12));
    }
    this.pingTimer -= frameSeconds;
    if (this.pingTimer <= 0) {
      this.pingTimer = PING_INTERVAL;
      this.transport.sendPing(performance.now(), this.rtt || undefined);
    }
    if (this.messageTimer > 0) {
      this.messageTimer -= frameSeconds;
      if (this.messageTimer <= 0) {
        this.hud.set({ message: null });
      }
    }
    // 陣亡後釋放滑鼠，讓玩家在部署畫面選擇兵種與出生點
    if (!this.spawnedLocally && this.life !== 'downed' && this.deathAt > 0 && performance.now() - this.deathAt > 1500 && this.input.isPointerLocked) {
      this.input.exitPointerLock();
    }
  }

  protected localAlive(): boolean {
    return this.spawnedLocally && this.life === 'alive';
  }

  protected mapMarkers(): MapMarker[] {
    const markers: MapMarker[] = (this.matchState?.objectives ?? []).map((o) => ({ kind: 'objective', x: o.position[0], z: o.position[2], label: o.id, radius: o.radius, team: o.owner }));
    for (const r of this.remotes.positions()) {
      if (!r.alive) {
        continue;
      }
      if (r.team === this.team) {
        markers.push({ kind: 'teammate', x: r.x, z: r.z, yaw: r.yaw, team: r.team });
      } else if (r.spotted) {
        markers.push({ kind: 'enemy', x: r.x, z: r.z, yaw: r.yaw, team: r.team });
      }
    }
    return markers;
  }

  // ---------------------------------------------------------------------------
  // 網路訊息

  private onWelcome(w: WelcomeMessage): void {
    this.team = w.team;
    this.remotes.myTeam = w.team;
    this.hud.set({ team: w.team });
  }

  private onPong(p: { t: number; tick: number }): void {
    this.rtt = performance.now() - p.t;
    this.hud.set({ ping: Math.round(this.rtt) });
  }

  private onConnectionChange(state: ConnectionState, detail?: string): void {
    this.connection = state;
    this.hud.set({ connection: state });
    if (state === 'disconnected' && detail) {
      this.flashMessage(`已斷線（${detail}）`);
    }
    if (state === 'connected') {
      // 重連後清掉尚未確認的預測，等待伺服器狀態
      this.pending = [];
    }
  }

  flashMessage(text: string, seconds = 3): void {
    this.hud.set({ message: text });
    this.messageTimer = seconds;
  }

  applySnapshot(snapshot: SnapshotMessage): void {
    if (snapshot.t <= this.lastSnapshotTick && this.lastSnapshotTick !== this.welcome.serverTick) {
      return; // 過舊或重複
    }
    this.lastSnapshotTick = snapshot.t;
    this.lastSnapshotAt = performance.now();
    this.remotes.ingest(snapshot.t, snapshot.players);
    this.updateGrenades(snapshot);
    const self = snapshot.self;
    if (!self) {
      return;
    }
    const life = LIFE_CODES[self.life] ?? 'spectating';
    const serverState: CharacterState = {
      feet: { x: self.feet[0], y: self.feet[1], z: self.feet[2] },
      velocity: { x: self.vel[0], y: self.vel[1], z: self.vel[2] },
      intended: { x: self.int[0], z: self.int[1] },
      grounded: self.g,
      stance: STANCE_CODES[self.st] ?? 'standing',
    };

    if (life === 'alive' && !this.spawnedLocally) {
      this.onSpawn(serverState, self.weapons.map((w) => w.id), self.slot, self.classId);
    } else if ((life === 'dead' || life === 'spectating') && (this.spawnedLocally || this.life === 'downed')) {
      this.spawnedLocally = false;
      this.deathAt = performance.now();
      this.pending = [];
    } else if (life === 'downed' && this.life !== 'downed') {
      this.pending = [];
      this.player.setStateKeepingRender(serverState);
    }
    this.life = life;

    if (this.spawnedLocally && life === 'alive') {
      this.reconcile(snapshot.ack, serverState, self.weapons, self.slot);
    } else if (life === 'downed') {
      this.player.setStateKeepingRender(serverState);
    }

    this.hud.set({
      health: self.hp,
      maxHealth: self.maxHp,
      lifeState: life === 'alive' ? 'alive' : life === 'downed' ? 'downed' : 'dead',
      grenades: self.grenades,
      abilityName: getClassAbilityName(self.classId),
      abilityReadyIn: self.abilityReadyIn,
      respawnIn: self.respawnIn,
      bleedoutIn: self.bleedoutIn,
      reviveProgress: self.reviveProgress,
      restrictedWarning: self.restrictedIn,
      spotted: self.spotted,
    });
  }

  private onSpawn(state: CharacterState, weaponIds: string[], slot: number, classId: string): void {
    const loadout = sanitizeLoadout({ classId, primaryId: weaponIds[0] ?? '', secondaryId: weaponIds[1] ?? '' });
    const arsenal = new LocalArsenal(loadout);
    arsenal.slot = slot;
    arsenal.current.equip(this.simTime);
    this.weapons.replaceArsenal(arsenal);
    this.player.teleport(state.feet, 'standing');
    this.player.setState(state);
    this.pending = [];
    this.spawnedLocally = true;
    this.deathAt = 0;
  }

  /** 預測修正：比對伺服器在 ack 時的狀態與本機當時的預測，差太多就回到伺服器狀態並重播。 */
  private reconcile(ack: number, server: CharacterState, weapons: SnapshotMessage['self'] extends infer S ? (S extends { weapons: infer W } ? W : never) : never, serverSlot: number): void {
    while (this.pending.length > 0 && this.pending[0]!.seq < ack) {
      this.pending.shift();
    }
    const entry = this.pending[0]?.seq === ack ? this.pending.shift()! : null;
    const predicted = entry?.state ?? null;
    const error = predicted ? Math.hypot(predicted.feet.x - server.feet.x, predicted.feet.y - server.feet.y, predicted.feet.z - server.feet.z) : Infinity;
    if (error > RECONCILE_THRESHOLD || (predicted && predicted.stance !== server.stance)) {
      if (this.pending.length === 0 && !entry) {
        // 沒有可比對的預測（剛重連）：直接採用伺服器狀態
        this.player.setStateKeepingRender(server);
      } else {
        this.corrections++;
        this.player.body.setState(server);
        for (const p of this.pending) {
          this.player.body.step(characterInputFrom(p.frame), p.frame.y, 1 / TICK_RATE);
          this.map.sim.step();
          p.state = this.player.body.getState();
        }
        this.player.setStateKeepingRender(this.player.body.getState());
      }
    }
    // 彈藥：伺服器在 ack 時的值與本機當時的預測不同時，依差值修正
    const arsenal = this.weapons.arsenal;
    const serverWeapon = weapons[serverSlot];
    if (entry && serverWeapon && entry.weapon.slot === serverSlot) {
      const local = arsenal.weapons[serverSlot];
      if (local && (entry.weapon.ammo !== serverWeapon.ammo || entry.weapon.reserve !== serverWeapon.reserve || entry.weapon.shotSeq !== serverWeapon.seq)) {
        local.ammo = Math.max(0, local.ammo + (serverWeapon.ammo - entry.weapon.ammo));
        local.reserve = Math.max(0, local.reserve + (serverWeapon.reserve - entry.weapon.reserve));
        local.shotSeq += serverWeapon.seq - entry.weapon.shotSeq;
        for (const p of this.pending) {
          if (p.weapon.slot === serverSlot) {
            p.weapon.ammo += serverWeapon.ammo - entry.weapon.ammo;
            p.weapon.reserve += serverWeapon.reserve - entry.weapon.reserve;
            p.weapon.shotSeq += serverWeapon.seq - entry.weapon.shotSeq;
          }
        }
      }
    }
  }

  private updateGrenades(snapshot: SnapshotMessage): void {
    const seen = new Set<number>();
    for (const g of snapshot.grenades) {
      seen.add(g.id);
      let mesh = this.grenades.get(g.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.grenadeGeometry, this.grenadeMaterial);
        mesh.castShadow = true;
        mesh.position.set(...g.p);
        mesh.userData.target = new THREE.Vector3(...g.p);
        this.renderer.scene.add(mesh);
        this.grenades.set(g.id, mesh);
      }
      (mesh.userData.target as THREE.Vector3).set(...g.p);
    }
    for (const [id, mesh] of this.grenades) {
      if (!seen.has(id)) {
        mesh.removeFromParent();
        this.grenades.delete(id);
      }
    }
  }

  handleEvents(message: EventsMessage): void {
    for (const event of message.events) {
      this.handleEvent(event);
    }
  }

  private handleEvent(event: GameEvent): void {
    const myNumber = this.welcome.playerNumber;
    switch (event.k) {
      case 'shot': {
        if (event.p === myNumber) {
          return; // 自己的開火已在本機預測
        }
        const def = findWeapon(event.w) ?? getWeapon('ar_carbine');
        const origin = new THREE.Vector3(...event.o);
        const muzzle = this.remotes.muzzleOf(event.p, new THREE.Vector3()) ?? origin;
        this.effects.remoteMuzzleFlash(muzzle, def.presentation.muzzleFlashScale);
        event.e.slice(0, 3).forEach((end, i) => {
          const point = new THREE.Vector3(...end);
          if (i === 0) {
            this.effects.tracer(muzzle, point);
          }
          if (event.m === 'flesh' && i === 0) {
            this.effects.blood(point, point.clone().sub(origin).normalize());
          } else if (event.m !== 'default') {
            this.effects.impact(point, origin.clone().sub(point).normalize(), event.m);
          }
        });
        this.audio.gunshot(origin, { pitch: def.presentation.soundPitch, length: def.presentation.soundLength, suppressed: def.presentation.muzzleFlashScale < 0.3 });
        // 子彈從身邊飛過
        const end = new THREE.Vector3(...(event.e[0] ?? event.o));
        const camera = this.renderer.camera.position;
        const segment = end.clone().sub(origin);
        const t = Math.max(0, Math.min(1, camera.clone().sub(origin).dot(segment) / Math.max(1e-6, segment.lengthSq())));
        const closest = origin.clone().addScaledVector(segment, t);
        if (closest.distanceTo(camera) < 2.5 && t > 0.05 && t < 0.98) {
          this.audio.bulletWhiz(closest);
        }
        return;
      }
      case 'hit':
        this.confirmed.hits++;
        if (event.zone === 'head') {
          this.confirmed.headshots++;
        }
        if (event.kill) {
          this.confirmed.kills++;
        }
        this.showHitMarker(event.zone, event.kill);
        return;
      case 'damaged': {
        const from = new THREE.Vector3(...event.from);
        const toSource = from.sub(this.renderer.camera.position);
        const angle = Math.atan2(toSource.x, -toSource.z) + this.cameraRig.yaw;
        this.damageSerial++;
        this.hud.set({ damageFrom: { serial: this.damageSerial, angle } });
        this.cameraRig.addFlinch(Math.min(0.03, event.amount * 0.0008));
        return;
      }
      case 'kill': {
        this.killFeed = [
          ...this.killFeed.slice(-7),
          {
            id: ++this.killFeedId,
            killer: event.killerName || '—',
            killerTeam: event.killerTeam,
            victim: event.victimName,
            victimTeam: event.victimTeam,
            weapon: event.weapon,
            headshot: event.headshot,
            at: Date.now(),
          },
        ];
        this.hud.set({ killFeed: this.killFeed });
        if (event.victim === myNumber) {
          this.flashMessage(event.killer && event.killer !== myNumber ? `被 ${event.killerName} 擊倒` : '陣亡');
        }
        return;
      }
      case 'explosion': {
        const p = new THREE.Vector3(...event.p);
        this.effects.explosion(p);
        this.audio.explosion(p);
        return;
      }
      case 'revived':
        if (event.p === myNumber) {
          this.flashMessage('你已被救起');
        } else if (event.by === myNumber) {
          this.flashMessage('救援成功 +50');
        }
        return;
      case 'ability':
        if (event.p === myNumber) {
          this.flashMessage('技能已使用', 1.5);
        }
        return;
      case 'captured':
        this.flashMessage(event.team ? `據點 ${event.id} 已被 ${event.team === 'alpha' ? 'ALPHA' : 'BRAVO'} 佔領` : `據點 ${event.id} 已失守`);
        return;
      case 'message':
        this.flashMessage(event.text);
        return;
      case 'spawn':
        return;
    }
  }

  applyMatchState(state: MatchStateMessage): void {
    this.matchState = state;
    const me = this.welcome.playerNumber;
    const feet = this.player.body.position;
    const rows: ScoreboardRow[] = state.players.map((p) => ({
      id: String(p.n),
      name: p.name,
      team: p.team,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      score: p.score,
      ping: p.ping,
      alive: p.alive,
      connected: p.connected,
      bot: p.bot,
      classId: p.classId,
      isSelf: p.n === me,
    }));
    const selfRow = state.players.find((p) => p.n === me);
    if (selfRow && selfRow.team !== this.team) {
      this.team = selfRow.team;
      this.remotes.myTeam = selfRow.team;
    }
    this.hud.set({
      phase: state.phase,
      timeLeft: state.timeLeft,
      teamScores: state.scores,
      scoreLimit: state.scoreLimit,
      winner: state.winner,
      team: this.team,
      scoreboard: rows,
      objectives: state.objectives.map((o) => ({
        id: o.id,
        name: o.name,
        owner: o.owner,
        progress: o.progress,
        contested: o.contested,
        inside: this.life === 'alive' && Math.hypot(feet.x - o.position[0], feet.z - o.position[2]) <= o.radius,
      })),
    });
  }

  protected override extendDebugHook(hook: FrontlineDebugHook): void {
    hook.combat = () => ({ ...this.confirmed });
    hook.net = () => ({
      playerNumber: this.welcome.playerNumber,
      team: this.team,
      life: this.life,
      spawned: this.spawnedLocally,
      pending: this.pending.length,
      corrections: this.corrections,
      rtt: Math.round(this.rtt),
      remotes: this.remotes.count,
      remotePositions: this.remotes.positions(),
      serverTick: this.lastSnapshotTick,
      renderTick: Math.round(this.renderTick()),
      roomId: this.transport.roomId,
      connection: this.connection,
      mode: this.welcome.mode,
      mapId: this.welcome.mapId,
      phase: this.matchState?.phase ?? null,
    });
    hook.devTeleport = (x, y, z) => this.transport.sendDebug({ cmd: 'teleport', x, y, z });
    hook.devSkipWarmup = () => this.transport.sendDebug({ cmd: 'skipWarmup' });
    hook.simulateDrop = () => this.transport.simulateDrop();
    hook.leave = () => this.transport.leave();
  }

  protected override disposeExtras(): void {
    void this.transport.leave();
    this.remotes.dispose();
    for (const mesh of this.grenades.values()) {
      mesh.removeFromParent();
    }
    this.grenadeGeometry.dispose();
    this.grenadeMaterial.dispose();
  }
}

function getClassAbilityName(classId: string): string {
  const names: Record<string, string> = { assault: '興奮劑', medic: '治療脈衝', support: '彈藥補給', recon: '標定' };
  return names[classId] ?? '';
}
