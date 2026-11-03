import { eyeHeight, type Stance } from '@frontline/shared';
import type * as THREE from 'three';
import type { GameSettings } from '../core/settings';
import { horizontalToVerticalFov } from './fov';
import type { Vec3 } from '@frontline/shared';

const BASE_RADIANS_PER_PIXEL = 0.0022;
const PITCH_LIMIT = (89 * Math.PI) / 180;
/** 眼睛高度跟隨速度（每秒），讓蹲下站起有平滑過渡 */
const EYE_HEIGHT_SHARPNESS = 14;
/** 落地下沉的上限與回復速度 */
const LANDING_MAX_DIP = 0.07;
const LANDING_DIP_PER_SPEED = 0.012;
const LANDING_RECOVERY_SHARPNESS = 10;

/** 第一人稱相機：yaw/pitch、視野、眼高平滑與落地回饋。 */
export class CameraRig {
  yaw: number;
  pitch = 0;
  private currentEyeHeight: number;
  private landingDip = 0;
  private settings: GameSettings;

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

  /** 套用滑鼠位移（像素）。pitch 夾在 ±89 度，相機不會翻轉。 */
  applyLook(dxPixels: number, dyPixels: number): void {
    const scale = BASE_RADIANS_PER_PIXEL * this.settings.mouseSensitivity;
    const invert = this.settings.invertY ? -1 : 1;
    this.yaw -= dxPixels * scale;
    this.pitch -= dyPixels * scale * invert;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    // 讓 yaw 保持在 -π 到 π，避免長時間轉動後精度下降。
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
  }

  addLandingImpact(impactSpeed: number): void {
    this.landingDip = Math.min(LANDING_MAX_DIP, this.landingDip + impactSpeed * LANDING_DIP_PER_SPEED);
  }

  /** 每個渲染畫格更新相機位置、角度與視野。feet 為內插後的腳底位置。 */
  update(feet: Vec3, stance: Stance, aspect: number, frameSeconds: number): void {
    const target = eyeHeight(stance);
    const t = 1 - Math.exp(-EYE_HEIGHT_SHARPNESS * frameSeconds);
    this.currentEyeHeight += (target - this.currentEyeHeight) * t;
    this.landingDip *= Math.exp(-LANDING_RECOVERY_SHARPNESS * frameSeconds);

    this.camera.position.set(feet.x, feet.y + this.currentEyeHeight - this.landingDip, feet.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const fov = horizontalToVerticalFov(this.settings.fieldOfView, aspect);
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
