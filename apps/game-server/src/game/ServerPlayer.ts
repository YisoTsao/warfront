import { getClass, sanitizeLoadout, type ClassDefinition, type Loadout } from '@frontline/game-config';
import type { InputFrame, TeamName, Vec3 } from '@frontline/shared';
import { CharacterBody, WeaponState, type SimWorld } from '@frontline/simulation';
import { DEFAULT_HEALTH, Health } from './Health';
import { InputQueue } from './InputQueue';

export interface PlayerStats {
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  revives: number;
  captures: number;
}

/** 一位玩家（真人或 bot）在伺服器上的完整權威狀態。 */
export class ServerPlayer {
  readonly inputs = new InputQueue();
  readonly stats: PlayerStats = { kills: 0, deaths: 0, assists: 0, score: 0, revives: 0, captures: 0 };
  /** 最近 10 秒內誰對這位玩家造成多少傷害（助攻判定） */
  readonly damageLog = new Map<number, { amount: number; at: number }>();
  loadout: Loadout;
  classDef: ClassDefinition;
  body: CharacterBody | null = null;
  health: Health;
  weapons: WeaponState[] = [];
  slot = 0;
  /** 武器狀態機的時間軸：每處理一個輸入框推進一個 tick */
  weaponClock = 0;
  /** 輸入處理額度（見 Match.step） */
  inputBudget = 1;
  starvedTicks = 0;
  grenades = 0;
  lastThrowAt = -100;
  abilityReadyAt = 0;
  connected = true;
  sessionId: string | null;
  /** 斷線保留位置的期限 */
  reservedUntil = 0;
  lastFrame: InputFrame | null = null;
  respawnAt = 0;
  deployRequested = false;
  deploySpawn = 'base';
  spottedUntil = 0;
  reviveTarget: number | null = null;
  reviveProgress = 0;
  giveUpHeld = 0;
  restrictedTime = 0;
  /** 已經為這次倒地／死亡計算過擊殺 */
  killCredited = false;
  lastDeathPosition: Vec3 | null = null;
  ping = 0;
  /** 速度、射速等可疑輸入次數（記錄供人工檢查） */
  suspicious = 0;
  joinedAt: number;

  constructor(
    readonly number: number,
    readonly guestId: string,
    public name: string,
    public team: TeamName,
    readonly bot: boolean,
    sessionId: string | null,
    now: number,
    loadout?: Partial<Loadout>,
  ) {
    this.sessionId = sessionId;
    this.loadout = sanitizeLoadout(loadout);
    this.classDef = getClass(this.loadout.classId);
    this.health = new Health({ ...DEFAULT_HEALTH, maxHealth: this.classDef.maxHealth, downedEnabled: false });
    this.health.state = 'spectating';
    this.joinedAt = now;
  }

  get spawned(): boolean {
    return this.body !== null && (this.health.state === 'alive' || this.health.state === 'downed');
  }

  get alive(): boolean {
    return this.health.state === 'alive' && this.body !== null;
  }

  get currentWeapon(): WeaponState | null {
    return this.weapons[this.slot] ?? null;
  }

  setLoadout(loadout: Partial<Loadout>): void {
    this.loadout = sanitizeLoadout(loadout);
  }

  /** 依目前配裝出生（武器、手榴彈、技能重置）。 */
  spawn(sim: SimWorld, feet: Vec3, yaw: number, downedEnabled: boolean, now: number): void {
    this.classDef = getClass(this.loadout.classId);
    if (!this.body) {
      this.body = new CharacterBody(sim, feet);
    }
    this.body.teleport(feet);
    this.body.speedScale = 1;
    this.health.reset({ ...DEFAULT_HEALTH, maxHealth: this.classDef.maxHealth, downedEnabled });
    this.weapons = [
      new WeaponState(this.loadout.primaryId, this.loadout.attachments[this.loadout.primaryId] ?? [], 0),
      new WeaponState(this.loadout.secondaryId, this.loadout.attachments[this.loadout.secondaryId] ?? [], 1),
    ];
    this.slot = 0;
    this.weaponClock = 0;
    this.weapons[0]!.equip(0);
    this.grenades = this.classDef.grenade.count;
    this.abilityReadyAt = now;
    this.inputs.clear();
    this.lastFrame = { s: this.inputs.ack, f: 0, r: 0, b: 0, st: 0, y: yaw, p: 0, w: 0, vt: 0 };
    this.deployRequested = false;
    this.damageLog.clear();
    this.reviveTarget = null;
    this.reviveProgress = 0;
    this.giveUpHeld = 0;
    this.restrictedTime = 0;
    this.killCredited = false;
    this.spottedUntil = 0;
  }

  /** 移出模擬（死亡、斷線）。保留 body 的位置作為屍體顯示。 */
  markDead(now: number, respawnSeconds: number): void {
    this.lastDeathPosition = this.body ? { ...this.body.position } : this.lastDeathPosition;
    this.respawnAt = now + respawnSeconds;
    this.reviveTarget = null;
    this.reviveProgress = 0;
  }

  dispose(): void {
    this.body?.dispose();
    this.body = null;
  }
}
