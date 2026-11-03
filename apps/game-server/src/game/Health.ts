import type { LifeState } from '@frontline/shared';

export interface HealthConfig {
  maxHealth: number;
  downedEnabled: boolean;
  bleedoutSeconds: number;
  regenDelaySeconds: number;
  regenPerSecond: number;
}

export const DEFAULT_HEALTH: Omit<HealthConfig, 'maxHealth' | 'downedEnabled'> = {
  bleedoutSeconds: 20,
  regenDelaySeconds: 7,
  regenPerSecond: 8,
};

export type HealthTransition = 'downed' | 'dead' | 'revived' | null;

/**
 * 伺服器權威的血量狀態機（沿用舊版 UE5 FLHealthComponent）：
 * 存活 →（血量歸零）→ 倒地 →（流血、再受傷、放棄）→ 死亡；倒地 →（救援）→ 存活。
 */
export class Health {
  health: number;
  state: LifeState = 'alive';
  bleedoutEnd = 0;
  private lastDamageAt = -100;

  constructor(public config: HealthConfig) {
    this.health = config.maxHealth;
  }

  reset(config: HealthConfig): void {
    this.config = config;
    this.health = config.maxHealth;
    this.state = 'alive';
    this.lastDamageAt = -100;
  }

  damage(amount: number, now: number): HealthTransition {
    if (amount <= 0 || this.state === 'dead' || this.state === 'spectating') {
      return null;
    }
    this.lastDamageAt = now;
    if (this.state === 'downed') {
      this.state = 'dead';
      this.health = 0;
      return 'dead';
    }
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) {
      return null;
    }
    if (this.config.downedEnabled) {
      this.state = 'downed';
      this.bleedoutEnd = now + this.config.bleedoutSeconds;
      return 'downed';
    }
    this.state = 'dead';
    return 'dead';
  }

  heal(amount: number): void {
    if (this.state === 'alive' && amount > 0) {
      this.health = Math.min(this.config.maxHealth, this.health + amount);
    }
  }

  revive(fraction: number, now: number): HealthTransition {
    if (this.state !== 'downed') {
      return null;
    }
    this.state = 'alive';
    this.health = Math.max(0.05, Math.min(1, fraction)) * this.config.maxHealth;
    this.lastDamageAt = now;
    return 'revived';
  }

  kill(): HealthTransition {
    if (this.state === 'dead' || this.state === 'spectating') {
      return null;
    }
    this.state = 'dead';
    this.health = 0;
    return 'dead';
  }

  tick(now: number, dt: number): HealthTransition {
    if (this.state === 'downed' && now >= this.bleedoutEnd) {
      this.state = 'dead';
      this.health = 0;
      return 'dead';
    }
    if (this.state === 'alive' && this.health < this.config.maxHealth && now - this.lastDamageAt >= this.config.regenDelaySeconds) {
      this.health = Math.min(this.config.maxHealth, this.health + this.config.regenPerSecond * dt);
    }
    return null;
  }
}
