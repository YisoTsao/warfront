/**
 * 移動與角色尺寸常數。前端預測與之後的權威伺服器必須共用同一份數值。
 *
 * 數值來源：舊版 UE5 骨架（legacy/ue5）的 FLCharacterMovementComponent 與 FLCharacter，
 * 已由公分換算為公尺。
 */
export const MOVEMENT = {
  /** 公尺／秒 */
  walkSpeed: 3.6,
  crouchSpeed: 2.0,
  sprintSpeed: 6.0,
  /** 公尺／秒² */
  groundAcceleration: 18,
  groundDeceleration: 18,
  /** 空中加速度占地面加速度的比例 */
  airControl: 0.15,
  /** 起跳垂直速度（公尺／秒），約可跳高 0.74 公尺 */
  jumpVelocity: 3.8,
  gravity: 9.81,
  maxFallSpeed: 50,
  /** 移動方向與面向的最小內積；低於此值不能衝刺（只能向前衝刺）。 */
  sprintForwardDot: 0.6,
  /** 可爬上的最大坡度（度） */
  maxSlopeClimbDegrees: 45,
  /** 超過此坡度會滑下（度） */
  minSlopeSlideDegrees: 50,
  /** 自動跨上台階的最大高度與最小落腳寬度（公尺） */
  stepHeight: 0.35,
  stepMinWidth: 0.2,
  /** 下坡或下台階時貼地的距離（公尺） */
  snapToGroundDistance: 0.3,
} as const;

/** 角色膠囊體。halfHeight 為含上下半球的總高度一半（與 UE 慣例相同）。 */
export const CAPSULE = {
  radius: 0.34,
  standingHalfHeight: 0.92,
  crouchingHalfHeight: 0.6,
} as const;

/** 眼睛高度，從腳底算起（公尺）。 */
export const EYE_HEIGHT = {
  standing: 1.64,
  crouching: 1.0,
} as const;

export function capsuleHalfHeight(stance: Stance): number {
  return stance === 'crouching' ? CAPSULE.crouchingHalfHeight : CAPSULE.standingHalfHeight;
}

export function eyeHeight(stance: Stance): number {
  return stance === 'crouching' ? EYE_HEIGHT.crouching : EYE_HEIGHT.standing;
}

export type Stance = 'standing' | 'crouching';
