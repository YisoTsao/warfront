import { eyeHeight, type Stance, type Vec3 } from '@frontline/shared';
import type * as THREE from 'three';
import type { GameSettings } from '../core/settings';
import { horizontalToVerticalFov } from './fov';

const BASE_RADIANS_PER_PIXEL = 0.0022;
const DEG = Math.PI / 180;
const PITCH_LIMIT = 89 * DEG;
const EYE_HEIGHT_SHARPNESS = 14;
const LANDING_MAX_DIP = 0.07;
const LANDING_DIP_PER_SPEED = 0.012;
const LANDING_RECOVERY_SHARPNESS = 10;

export interface RecoilRecovery {
  /** 停止射擊後自動回復的比例 */
  fraction: number;
  degreesPerSecond: number;
  delaySeconds: number;
}

/** 第一人稱相機：yaw/pitch、視野（含 ADS）、眼高平滑、落地回饋與後座力回復。 */
export class CameraRig {
  yaw: number;
  pitch = 0;
  private currentEyeHeight: number;
  private landingDip = 0;
  private settings: GameSettings;
  private pendingRecovery = 0;
  private recoverySinceShot = 0;
  private recovery: RecoilRecovery = { fraction: 0.6, degreesPerSecond: 10, delaySeconds: 0.1 };
  /** 0 = 腰射、1 = 完全瞄準 */
  adsAlpha = 0;
  adsFov = 90;
  /** 受傷時的視角晃動（弧度），快速衰減 */
  private flinch = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    initialYaw: number,
    settings: GameSettings,
  ) {
    this.yaw = initialYaw;
    this.settings = settings;
    this.currentEyeHeight = eyeHeight('standing');
  }

  applySettings(settings: GameSettings): void {
    this.settings = settings;
  }

  /** 套用滑鼠位移（像素）。pitch 夾在 ±89 度；ADS 時依縮放降低靈敏度。 */
  applyLook(dxPixels: number, dyPixels: number): void {
    const zoom = this.currentHorizontalFov() / this.settings.fieldOfView;
    const scale = BASE_RADIANS_PER_PIXEL * this.settings.mouseSensitivity * zoom;
    const invert = this.settings.invertY ? -1 : 1;
    this.yaw -= dxPixels * scale;
    const pitchDelta = -dyPixels * scale * invert;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + pitchDelta));
    // 玩家主動往下壓槍時，抵銷待回復的後座力
    if (pitchDelta < 0 && this.pendingRecovery > 0) {
      this.pendingRecovery = Math.max(0, this.pendingRecovery + pitchDelta / DEG);
    }
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  /** 後座力：立即抬高視角，之後依武器設定回復一部分。 */
  addRecoil(pitchDegrees: number, yawDegrees: number, recovery: RecoilRecovery): void {
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + pitchDegrees * DEG));
    this.yaw += yawDegrees * DEG;
    this.recovery = recovery;
    this.pendingRecovery += pitchDegrees * recovery.fraction;
    this.recoverySinceShot = 0;
  }

  addLandingImpact(impactSpeed: number): void {
    this.landingDip = Math.min(LANDING_MAX_DIP, this.landingDip + impactSpeed * LANDING_DIP_PER_SPEED);
  }

  addFlinch(amount: number): void {
    this.flinch = Math.min(0.04, this.flinch + amount);
  }

  currentHorizontalFov(): number {
    return this.settings.fieldOfView + (Math.min(this.adsFov, this.settings.fieldOfView) - this.settings.fieldOfView) * smoothstep(this.adsAlpha);
  }

  /** 每個渲染畫格更新相機位置、角度與視野。feet 為內插後的腳底位置。 */
  update(feet: Vec3, stance: Stance, aspect: number, frameSeconds: number): void {
    const target = eyeHeight(stance);
    const t = 1 - Math.exp(-EYE_HEIGHT_SHARPNESS * frameSeconds);
    this.currentEyeHeight += (target - this.currentEyeHeight) * t;
    this.landingDip *= Math.exp(-LANDING_RECOVERY_SHARPNESS * frameSeconds);

    this.recoverySinceShot += frameSeconds;
    if (this.pendingRecovery > 0 && this.recoverySinceShot >= this.recovery.delaySeconds) {
      const step = Math.min(this.pendingRecovery, this.recovery.degreesPerSecond * frameSeconds);
      this.pitch = Math.max(-PITCH_LIMIT, this.pitch - step * DEG);
      this.pendingRecovery -= step;
    }
    this.flinch *= Math.exp(-12 * frameSeconds);

    this.camera.position.set(feet.x, feet.y + this.currentEyeHeight - this.landingDip, feet.z);
    this.camera.rotation.set(this.pitch + this.flinch, this.yaw, 0, 'YXZ');

    const fov = horizontalToVerticalFov(this.currentHorizontalFov(), aspect);
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  get eyeHeightNow(): number {
    return this.currentEyeHeight;
  }
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
