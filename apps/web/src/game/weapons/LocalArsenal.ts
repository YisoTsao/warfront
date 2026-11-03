import type { Loadout } from '@frontline/game-config';
import { WeaponState, type WeaponEvent } from '@frontline/simulation';
import type { InputAction } from '../input/keyBindings';

export interface ArsenalInput {
  held: ReadonlySet<InputAction>;
  pressed: ReadonlySet<InputAction>;
}

export interface ArsenalStepResult {
  events: WeaponEvent[];
  switchedTo: number | null;
}

/**
 * 本機玩家的武器欄（主武器、副武器）。每個模擬步驟以與伺服器相同的輸入推進，
 * 彈藥與射擊序號才會和伺服器一致。
 */
export class LocalArsenal {
  readonly weapons: WeaponState[];
  slot = 0;
  /** 視覺用：換彈與切槍的開始時間 */
  reloadStartedAt: number | null = null;
  reloadDuration = 0;
  equipStartedAt = -100;

  constructor(loadout: Loadout) {
    this.weapons = [
      new WeaponState(loadout.primaryId, loadout.attachments[loadout.primaryId] ?? [], 0),
      new WeaponState(loadout.secondaryId, loadout.attachments[loadout.secondaryId] ?? [], 1),
    ];
  }

  get current(): WeaponState {
    return this.weapons[this.slot]!;
  }

  /** 由按鍵決定要切到哪一把；沒有切換時回傳 null。 */
  requestedSlot(pressed: ReadonlySet<InputAction>): number | null {
    if (pressed.has('primaryWeapon')) {
      return 0;
    }
    if (pressed.has('secondaryWeapon')) {
      return 1;
    }
    if (pressed.has('nextWeapon') || pressed.has('previousWeapon')) {
      return (this.slot + 1) % this.weapons.length;
    }
    return null;
  }

  switchTo(slot: number, now: number): boolean {
    if (slot === this.slot || !this.weapons[slot]) {
      return false;
    }
    this.current.holster();
    this.slot = slot;
    this.current.equip(now);
    this.equipStartedAt = now;
    this.reloadStartedAt = null;
    return true;
  }

  step(now: number, dt: number, input: ArsenalInput, canFire: boolean, desiredSlot: number | null): ArsenalStepResult {
    let switchedTo: number | null = null;
    if (desiredSlot !== null && this.switchTo(desiredSlot, now)) {
      switchedTo = desiredSlot;
    }
    const events = this.current.update(now, dt, {
      trigger: canFire && input.held.has('fire'),
      reload: canFire && input.pressed.has('reload'),
      cycleFireMode: input.pressed.has('fireMode'),
    });
    for (const event of events) {
      if (event.type === 'reloadStart') {
        this.reloadStartedAt = event.time;
        this.reloadDuration = event.duration;
      } else if (event.type === 'reloadEnd' || event.type === 'shot') {
        this.reloadStartedAt = this.current.reloading ? this.reloadStartedAt : null;
      }
    }
    if (!this.current.reloading) {
      this.reloadStartedAt = null;
    }
    return { events, switchedTo };
  }

  /** 換彈進度 0–1（逐發裝填時為單發進度）；沒有換彈時為 null。 */
  reloadProgress(now: number): number | null {
    if (this.reloadStartedAt === null || this.reloadDuration <= 0) {
      return null;
    }
    return Math.min(1, (now - this.reloadStartedAt) / this.reloadDuration);
  }

  equipProgress(now: number): number {
    return Math.min(1, (now - this.equipStartedAt) / Math.max(0.05, this.current.def.equipSeconds));
  }

  refillAll(): void {
    for (const weapon of this.weapons) {
      weapon.refill();
    }
  }
}
