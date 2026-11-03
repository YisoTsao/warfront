import { applyAttachments, fireIntervalSeconds, getWeapon, type FireMode, type WeaponDefinition } from '@frontline/game-config';

export interface WeaponInput {
  /** 扳機是否按住 */
  trigger: boolean;
  /** 這一步新按下換彈 */
  reload: boolean;
  /** 這一步新按下切換射擊模式 */
  cycleFireMode: boolean;
}

export type WeaponEvent =
  | { type: 'shot'; time: number; shotSeq: number; bloom: number; consecutive: number }
  | { type: 'dryFire'; time: number }
  | { type: 'reloadStart'; time: number; duration: number; empty: boolean }
  | { type: 'reloadEnd'; time: number }
  | { type: 'fireMode'; mode: FireMode };

export interface WeaponStateSnapshot {
  weaponId: string;
  ammo: number;
  reserve: number;
  fireModeIndex: number;
  reloading: boolean;
  shotSeq: number;
}

/**
 * 一把武器的權威狀態機，以模擬時間推進（不依賴計時器）。
 * 伺服器與開槍者的客戶端以相同輸入執行，彈藥與射擊序號才會一致。
 */
export class WeaponState {
  readonly def: WeaponDefinition;
  ammo: number;
  reserve: number;
  fireModeIndex = 0;
  shotSeq = 0;
  bloom = 0;
  consecutiveShots = 0;
  private reloadingUntil: number | null = null;
  private reloadPerRoundNext: number | null = null;
  private equipReadyAt = 0;
  private nextShotAt = 0;
  private lastShotAt = -100;
  private triggerWasHeld = false;
  private burstRemaining = 0;

  constructor(
    weaponId: string,
    attachments: readonly string[] = [],
    readonly slot = 0,
  ) {
    this.def = applyAttachments(getWeapon(weaponId), attachments);
    this.ammo = this.def.magazineSize;
    this.reserve = this.def.maxReserveAmmo;
  }

  get fireMode(): FireMode {
    return this.def.fireModes[this.fireModeIndex] ?? 'single';
  }

  get reloading(): boolean {
    return this.reloadingUntil !== null || this.reloadPerRoundNext !== null;
  }

  equip(now: number): void {
    this.equipReadyAt = now + this.def.equipSeconds;
    this.cancelReload();
    this.burstRemaining = 0;
    this.consecutiveShots = 0;
    this.triggerWasHeld = true; // 切槍時按住的扳機不算新的一下
  }

  holster(): void {
    this.cancelReload();
    this.burstRemaining = 0;
  }

  refill(): void {
    this.reserve = this.def.maxReserveAmmo;
  }

  /** 推進到 now（秒）。dt 用於 bloom 回復。 */
  update(now: number, dt: number, input: WeaponInput): WeaponEvent[] {
    const events: WeaponEvent[] = [];
    const interval = fireIntervalSeconds(this.def);

    if (input.cycleFireMode && this.def.fireModes.length > 1) {
      this.fireModeIndex = (this.fireModeIndex + 1) % this.def.fireModes.length;
      this.burstRemaining = 0;
      events.push({ type: 'fireMode', mode: this.fireMode });
    }

    this.updateReload(now, events);

    const pressed = input.trigger && !this.triggerWasHeld;
    this.triggerWasHeld = input.trigger;

    // 逐發裝填可以被開火打斷
    if (pressed && this.reloadPerRoundNext !== null && this.ammo > 0) {
      this.cancelReload();
    }

    if (input.reload && this.canReload()) {
      this.beginReload(now, events);
    }

    if (pressed && this.fireMode === 'burst' && this.burstRemaining <= 0) {
      this.burstRemaining = this.def.burstCount;
    }

    // 一個 tick 內可能有多發（高射速、低 tick rate）
    let guard = 0;
    while (guard++ < 8) {
      const wants =
        this.fireMode === 'auto' ? input.trigger : this.fireMode === 'burst' ? this.burstRemaining > 0 : pressed && guard === 1;
      if (!wants) {
        break;
      }
      const shotTime = Math.max(this.nextShotAt, this.equipReadyAt, now - dt);
      if (shotTime > now) {
        break;
      }
      if (this.reloading || now < this.equipReadyAt) {
        break;
      }
      if (this.ammo <= 0) {
        if (pressed || this.fireMode !== 'auto') {
          events.push({ type: 'dryFire', time: now });
        }
        this.burstRemaining = 0;
        if (this.canReload()) {
          this.beginReload(now, events);
        }
        break;
      }
      this.ammo--;
      this.shotSeq++;
      events.push({ type: 'shot', time: shotTime, shotSeq: this.shotSeq, bloom: this.bloom, consecutive: this.consecutiveShots });
      this.consecutiveShots++;
      this.bloom = Math.min(this.bloom + this.def.spread.perShot, this.def.spread.maxBloom);
      this.lastShotAt = shotTime;
      this.nextShotAt = shotTime + interval;
      if (this.fireMode === 'burst') {
        this.burstRemaining--;
      }
      if (this.fireMode === 'single') {
        break;
      }
    }

    if (!input.trigger && this.fireMode !== 'burst') {
      this.consecutiveShots = 0;
    }
    if (now - this.lastShotAt > interval * 1.5) {
      this.bloom = Math.max(0, this.bloom - this.def.spread.bloomRecoveryPerSecond * dt);
      if (this.fireMode === 'burst' && this.burstRemaining <= 0) {
        this.consecutiveShots = 0;
      }
    }
    return events;
  }

  snapshot(): WeaponStateSnapshot {
    return {
      weaponId: this.def.id,
      ammo: this.ammo,
      reserve: this.reserve,
      fireModeIndex: this.fireModeIndex,
      reloading: this.reloading,
      shotSeq: this.shotSeq,
    };
  }

  canReload(): boolean {
    return !this.reloading && this.reserve > 0 && this.ammo < this.def.magazineSize;
  }

  private beginReload(now: number, events: WeaponEvent[]): void {
    this.burstRemaining = 0;
    const empty = this.ammo === 0;
    if (this.def.reloadPerRound) {
      this.reloadPerRoundNext = now + this.def.perRoundReloadSeconds;
      events.push({ type: 'reloadStart', time: now, duration: this.def.perRoundReloadSeconds, empty });
      return;
    }
    const duration = empty ? this.def.emptyReloadSeconds : this.def.reloadSeconds;
    this.reloadingUntil = now + duration;
    events.push({ type: 'reloadStart', time: now, duration, empty });
  }

  private updateReload(now: number, events: WeaponEvent[]): void {
    if (this.reloadingUntil !== null && now >= this.reloadingUntil) {
      const loaded = Math.min(this.def.magazineSize - this.ammo, this.reserve);
      this.ammo += loaded;
      this.reserve -= loaded;
      this.reloadingUntil = null;
      events.push({ type: 'reloadEnd', time: now });
    }
    while (this.reloadPerRoundNext !== null && now >= this.reloadPerRoundNext) {
      if (this.reserve > 0 && this.ammo < this.def.magazineSize) {
        this.ammo++;
        this.reserve--;
      }
      if (this.reserve > 0 && this.ammo < this.def.magazineSize) {
        this.reloadPerRoundNext += this.def.perRoundReloadSeconds;
      } else {
        this.reloadPerRoundNext = null;
        events.push({ type: 'reloadEnd', time: now });
      }
    }
  }

  private cancelReload(): void {
    this.reloadingUntil = null;
    this.reloadPerRoundNext = null;
  }
}
