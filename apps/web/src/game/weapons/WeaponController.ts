import { damageAtDistance, type WeaponDefinition } from '@frontline/game-config';
import { directionFromYawPitch, eyeHeight, type Stance, type Vec3 } from '@frontline/shared';
import { pelletDirections, shotSeed, spreadDegrees, zoneMultiplier, type CharacterSnapshot, type HitZone, type SimWorld, type WeaponEvent } from '@frontline/simulation';
import * as THREE from 'three';
import type { AudioSystem } from '../audio/AudioSystem';
import type { HudStore } from '../hud/HudStore';
import type { SimulationInput } from '../input/InputManager';
import type { CameraRig } from '../player/CameraRig';
import { horizontalToVerticalFov } from '../player/fov';
import type { Effects } from '../vfx/Effects';
import type { LocalArsenal } from './LocalArsenal';
import type { Viewmodel } from './Viewmodel';

const DEG = Math.PI / 180;
const FIRE_MODE_LABELS: Record<string, string> = { auto: '全自動', burst: '三發點放', single: '單發' };

export interface PelletResult {
  /** 彈道終點（打到東西的位置或最大射程） */
  end: Vec3;
  normal: Vec3 | null;
  material: string;
  /** 打到角色 */
  target: { zone: HitZone; killed: boolean } | null;
}

/** 決定一顆彈丸打到什麼。單機時由前端判定並扣血；連線時只預測視覺效果，傷害由伺服器決定。 */
export interface PelletResolver {
  resolve(weapon: WeaponDefinition, origin: Vec3, direction: Vec3, now: number): PelletResult;
}

export interface ShotRecord {
  shotSeq: number;
  slot: number;
  origin: Vec3;
  directions: Vec3[];
  results: PelletResult[];
}

/**
 * 本機玩家的開火流程：武器狀態 → 散佈與彈丸方向（與伺服器相同的種子規則）→ 命中判定 →
 * 後座力、武器模型、特效、音效、HUD。
 */
export class WeaponController {
  private adsAlpha = 0;
  private crosshair: HTMLElement | null = null;
  private lastSpread = 0;
  private aiming = false;
  readonly shotLog: ShotRecord[] = [];
  /** 由伺服器配發；單機時為隨機值 */
  matchSeed: number;
  playerNumber: number;

  constructor(
    public arsenal: LocalArsenal,
    private readonly viewmodel: Viewmodel,
    private readonly cameraRig: CameraRig,
    private readonly effects: Effects,
    private readonly audio: AudioSystem,
    private readonly hud: HudStore,
    private readonly sim: SimWorld,
    private resolver: PelletResolver,
    options: { matchSeed: number; playerNumber: number },
  ) {
    this.matchSeed = options.matchSeed;
    this.playerNumber = options.playerNumber;
    this.viewmodel.setWeapon(arsenal.current.def);
  }

  /** 重生時換成新的配裝。 */
  replaceArsenal(arsenal: LocalArsenal): void {
    this.arsenal = arsenal;
    this.viewmodel.setWeapon(arsenal.current.def);
    this.pushHud();
  }

  setResolver(resolver: PelletResolver): void {
    this.resolver = resolver;
  }

  attachCrosshair(element: HTMLElement | null): void {
    this.crosshair = element;
  }

  get isAiming(): boolean {
    return this.aiming;
  }

  /** 每個模擬步驟呼叫。回傳這一步的武器事件（連線時用來比對伺服器）。 */
  step(now: number, dt: number, input: SimulationInput, player: CharacterSnapshot, yaw: number, pitch: number, canAct: boolean): WeaponEvent[] {
    const sprinting = player.locomotion === 'sprinting';
    this.aiming = canAct && input.held.has('aim') && !sprinting;
    const desiredSlot = canAct ? this.arsenal.requestedSlot(input.pressed) : null;
    const result = this.arsenal.step(now, dt, input, canAct && !sprinting, desiredSlot);
    if (result.switchedTo !== null) {
      this.viewmodel.setWeapon(this.arsenal.current.def);
      this.audio.reloadStep('charge');
    }
    const def = this.arsenal.current.def;
    for (const event of result.events) {
      switch (event.type) {
        case 'shot':
          this.fire(def, event.shotSeq, event.bloom, event.consecutive, player, yaw, pitch, now);
          break;
        case 'dryFire':
          this.audio.dryFire();
          break;
        case 'reloadStart':
          this.audio.reloadStep('out');
          break;
        case 'reloadEnd':
          this.audio.reloadStep('in');
          break;
        default:
          break;
      }
    }
    this.lastSpread = spreadDegrees(def, this.spreadContext(player, this.arsenal.current.bloom));
    this.pushHud();
    return result.events;
  }

  /** 每個渲染畫格呼叫：ADS 過渡、武器模型、準星。 */
  frame(frameSeconds: number, now: number, player: CharacterSnapshot, look: { dx: number; dy: number }, visible: boolean, viewportHeight: number, aspect: number): void {
    const def = this.arsenal.current.def;
    const target = this.aiming ? 1 : 0;
    const rate = frameSeconds / Math.max(0.05, def.adsSeconds);
    const delta = target - this.adsAlpha;
    this.adsAlpha += Math.sign(delta) * Math.min(Math.abs(delta), rate);
    this.cameraRig.adsAlpha = this.adsAlpha;
    this.cameraRig.adsFov = def.adsFov;
    this.viewmodel.update(frameSeconds, {
      adsAlpha: this.adsAlpha,
      horizontalSpeed: Math.hypot(player.velocity.x, player.velocity.z),
      sprinting: player.locomotion === 'sprinting',
      grounded: player.grounded,
      reloadProgress: this.arsenal.reloadProgress(now),
      equipProgress: this.arsenal.equipProgress(now),
      lookDx: look.dx,
      lookDy: look.dy,
      visible,
    });
    if (this.crosshair) {
      const vfov = horizontalToVerticalFov(this.cameraRig.currentHorizontalFov(), aspect) * DEG;
      const pixels = (Math.tan(this.lastSpread * DEG) / Math.tan(vfov / 2)) * (viewportHeight / 2);
      this.crosshair.style.setProperty('--spread', `${Math.min(120, Math.max(3, pixels)).toFixed(1)}px`);
      this.crosshair.style.opacity = visible && this.adsAlpha < 0.6 ? '1' : '0';
    }
  }

  spreadContext(player: CharacterSnapshot, bloom: number) {
    return {
      aiming: this.aiming,
      stance: player.stance as Stance,
      moving: Math.hypot(player.velocity.x, player.velocity.z) > 0.5,
      airborne: !player.grounded,
      bloom,
    };
  }

  private fire(def: WeaponDefinition, shotSeq: number, bloom: number, consecutive: number, player: CharacterSnapshot, yaw: number, pitch: number, now: number): void {
    const origin = { x: player.feet.x, y: player.feet.y + eyeHeight(player.stance), z: player.feet.z };
    const aim = directionFromYawPitch(yaw, pitch);
    const spread = spreadDegrees(def, this.spreadContext(player, bloom));
    const seed = shotSeed(this.matchSeed, this.playerNumber, this.arsenal.slot, shotSeq);
    const directions = pelletDirections(def, aim, spread, seed);
    const results = directions.map((dir) => this.resolver.resolve(def, origin, dir, now));
    this.shotLog.push({ shotSeq, slot: this.arsenal.slot, origin, directions, results });
    if (this.shotLog.length > 64) {
      this.shotLog.shift();
    }

    // 視覺與音效
    const muzzle = this.viewmodel.muzzleWorldPosition(new THREE.Vector3());
    this.effects.muzzleFlash(null, muzzle, def.presentation.muzzleFlashScale);
    results.forEach((r, i) => {
      const end = new THREE.Vector3(r.end.x, r.end.y, r.end.z);
      if (i === 0 && (shotSeq % Math.max(1, def.presentation.tracerEvery) === 0 || def.damage.pellets > 1)) {
        this.effects.tracer(muzzle, end);
      }
      if (r.target) {
        this.effects.blood(end, new THREE.Vector3(directions[i]!.x, directions[i]!.y, directions[i]!.z));
      } else if (r.normal) {
        this.effects.impact(end, new THREE.Vector3(r.normal.x, r.normal.y, r.normal.z), r.material);
        if (i === 0) {
          this.audio.impact(r.end, r.material);
        }
      }
    });
    if (def.category !== 'shotgun' && def.category !== 'sniperRifle') {
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      this.effects.shell(muzzle.clone().addScaledVector(right, 0.05), right);
    }
    this.audio.gunshot(null, { pitch: def.presentation.soundPitch, length: def.presentation.soundLength, suppressed: def.presentation.muzzleFlashScale < 0.3 });
    this.viewmodel.kick(def.category === 'sniperRifle' || def.category === 'shotgun' ? 3 : 1);
    this.applyRecoil(def, consecutive, player.stance as Stance);
  }

  private applyRecoil(def: WeaponDefinition, consecutive: number, stance: Stance): void {
    const r = def.recoil;
    let multiplier = this.aiming ? r.aimMultiplier : 1;
    if (stance === 'crouching') {
      multiplier *= r.crouchMultiplier;
    } else if (stance === 'prone') {
      multiplier *= r.proneMultiplier;
    }
    if (consecutive === 0) {
      multiplier *= r.firstShotMultiplier;
    }
    const vertical = r.verticalKick * multiplier * (0.85 + Math.random() * 0.3);
    const horizontal = (Math.random() * 2 - 1 + r.horizontalBias) * r.horizontalKick * multiplier;
    this.cameraRig.addRecoil(vertical, horizontal, {
      fraction: r.recoveryFraction,
      degreesPerSecond: r.recoveryDegreesPerSecond,
      delaySeconds: r.recoveryDelaySeconds,
    });
  }

  private pushHud(): void {
    const w = this.arsenal.current;
    this.hud.set({
      weaponName: w.def.displayName,
      fireMode: FIRE_MODE_LABELS[w.fireMode] ?? w.fireMode,
      ammo: w.ammo,
      reserve: w.reserve,
      reloading: w.reloading,
    });
  }

  /** 單機用的命中判定：地圖射線 + 目標的 hitbox。 */
  static offlineResolver(sim: SimWorld, targets: { raycast(o: Vec3, d: Vec3, max: number): { index: number; zone: HitZone; distance: number } | null; damage(i: number, amount: number, now: number): boolean }, onHit: (zone: HitZone, killed: boolean) => void): PelletResolver {
    return {
      resolve(weapon, origin, direction, now) {
        const range = weapon.damage.maxRangeMeters;
        const world = sim.castBullet(origin, direction, range);
        const maxDistance = world ? world.distance : range;
        const target = targets.raycast(origin, direction, maxDistance);
        if (target) {
          const amount = damageAtDistance(weapon, target.distance) * zoneMultiplier(weapon, target.zone);
          const killed = targets.damage(target.index, amount, now);
          onHit(target.zone, killed);
          return {
            end: { x: origin.x + direction.x * target.distance, y: origin.y + direction.y * target.distance, z: origin.z + direction.z * target.distance },
            normal: null,
            material: 'flesh',
            target: { zone: target.zone, killed },
          };
        }
        if (world) {
          return { end: world.point, normal: world.normal, material: world.material, target: null };
        }
        return { end: { x: origin.x + direction.x * range, y: origin.y + direction.y * range, z: origin.z + direction.z * range }, normal: null, material: 'default', target: null };
      },
    };
  }
}
