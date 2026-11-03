import { clamp, length2, moveTowards, type Vec2 } from '../math/vector';
import { MOVEMENT, STANCES_BY_HEIGHT, type Stance } from './constants';

/** 一個模擬步驟的移動輸入。軸向值介於 -1 到 1。 */
export interface MoveInput {
  /** +1 向前，-1 向後 */
  forward: number;
  /** +1 向右，-1 向左 */
  right: number;
  sprint: boolean;
}

/** 由速度與狀態推導出的移動狀態，供 HUD、動畫與之後的網路同步使用。 */
export type Locomotion = 'idle' | 'walking' | 'sprinting' | 'airborne';

const IDLE_SPEED_THRESHOLD = 0.1;

/**
 * 以 yaw（弧度）把輸入軸轉成世界座標的移動方向。
 * 慣例與 Three.js 相同：yaw = 0 時面向 -Z，正 yaw 向左轉。
 * 回傳長度最多為 1 的向量；斜向移動不會比直線快。
 */
export function wishDirection(input: MoveInput, yaw: number): Vec2 {
  const forward = clamp(input.forward, -1, 1);
  const right = clamp(input.right, -1, 1);
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // forward 向量 = (-sin, -cos)，right 向量 = (cos, -sin)
  let x = -sin * forward + cos * right;
  let z = -cos * forward - sin * right;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

/** 只有站姿、按住衝刺且主要往前移動時才能衝刺。 */
export function canSprint(input: MoveInput, stance: Stance): boolean {
  if (!input.sprint || stance !== 'standing') {
    return false;
  }
  const magnitude = Math.hypot(input.forward, input.right);
  if (magnitude < 1e-3) {
    return false;
  }
  return input.forward / magnitude >= MOVEMENT.sprintForwardDot;
}

export function targetSpeed(stance: Stance, sprinting: boolean, aiming = false): number {
  let speed: number;
  if (stance === 'prone') {
    speed = MOVEMENT.proneSpeed;
  } else if (stance === 'crouching') {
    speed = MOVEMENT.crouchSpeed;
  } else {
    speed = sprinting && !aiming ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
  }
  return aiming ? speed * MOVEMENT.aimSpeedMultiplier : speed;
}

/**
 * 推進水平速度一步。地面上以加速度／減速度逼近目標速度；
 * 空中只保留部分控制力，且沒有輸入時保持慣性。
 */
export function stepHorizontalVelocity(
  current: Vec2,
  wishDir: Vec2,
  speed: number,
  grounded: boolean,
  dt: number,
): Vec2 {
  const hasInput = length2(wishDir) > 1e-4;
  const target = { x: wishDir.x * speed, z: wishDir.z * speed };
  if (grounded) {
    const rate = hasInput ? MOVEMENT.groundAcceleration : MOVEMENT.groundDeceleration;
    return moveTowards(current, target, rate * dt);
  }
  if (!hasInput) {
    return { x: current.x, z: current.z };
  }
  return moveTowards(current, target, MOVEMENT.groundAcceleration * MOVEMENT.airControl * dt);
}

export interface VerticalStepResult {
  velocityY: number;
  jumped: boolean;
}

/**
 * 推進垂直速度一步。jumpRequested 必須是「這一步新按下」的邊緣事件，
 * 按住跳躍鍵不會在落地後連跳，也不會在空中重複觸發。
 */
export function stepVerticalVelocity(
  velocityY: number,
  grounded: boolean,
  jumpRequested: boolean,
  stance: Stance,
  dt: number,
): VerticalStepResult {
  if (grounded && jumpRequested && stance === 'standing') {
    return { velocityY: MOVEMENT.jumpVelocity, jumped: true };
  }
  if (grounded && velocityY <= 0) {
    // 落地時不累積向下速度，交給貼地處理。
    return { velocityY: 0, jumped: false };
  }
  const next = Math.max(-MOVEMENT.maxFallSpeed, velocityY - MOVEMENT.gravity * dt);
  return { velocityY: next, jumped: false };
}

/**
 * 決定這一步的姿勢。往低處換一定成功；往高處換時，從想要的姿勢往下找第一個放得下的，
 * 都放不下就維持目前姿勢（例如在低矮通道內想站起來）。
 */
export function resolveStance(current: Stance, desired: Stance, fits: (stance: Stance) => boolean): Stance {
  const currentIndex = STANCES_BY_HEIGHT.indexOf(current);
  const desiredIndex = STANCES_BY_HEIGHT.indexOf(desired);
  if (desiredIndex <= currentIndex) {
    return desired;
  }
  for (let i = desiredIndex; i > currentIndex; i--) {
    const candidate = STANCES_BY_HEIGHT[i];
    if (candidate && fits(candidate)) {
      return candidate;
    }
  }
  return current;
}

/** 姿勢按鍵：蹲下與臥倒都是切換；再按一次回到站姿。 */
export function toggleStance(desired: Stance, pressed: 'crouch' | 'prone'): Stance {
  const target: Stance = pressed === 'crouch' ? 'crouching' : 'prone';
  return desired === target ? 'standing' : target;
}

export function resolveLocomotion(grounded: boolean, horizontalSpeed: number, sprinting: boolean): Locomotion {
  if (!grounded) {
    return 'airborne';
  }
  if (horizontalSpeed < IDLE_SPEED_THRESHOLD) {
    return 'idle';
  }
  return sprinting ? 'sprinting' : 'walking';
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 表面法線是否為可站立的地面或坡面（坡度不超過爬坡上限）。 */
export function isWalkableNormal(normal: Vec3Like, maxWalkableSlopeDegrees: number = MOVEMENT.maxSlopeClimbDegrees): boolean {
  return normal.y >= Math.cos((maxWalkableSlopeDegrees * Math.PI) / 180);
}

/** 取法線的水平方向並正規化；幾乎垂直向上或向下時回傳 null。 */
export function horizontalNormal(normal: Vec3Like): Vec2 | null {
  const length = Math.hypot(normal.x, normal.z);
  if (length < 1e-6) {
    return null;
  }
  return { x: normal.x / length, z: normal.z / length };
}

/**
 * 依「這一步真正擋住角色的牆」修正水平速度：移除朝向牆面的分量，保留沿牆滑動的分量。
 * 同時被多面牆擋住（例如推進牆角）且仍無法離開時，水平速度歸零，避免在牆角來回抖動。
 *
 * wallNormals 為各面牆朝外（指向角色）的水平單位法線。可行走的坡面與自動跨上的台階
 * 不應放進來，否則爬坡、上樓梯時速度會被削減。
 */
export function resolveBlockedVelocity(velocity: Vec2, wallNormals: readonly Vec2[]): Vec2 {
  let v = { x: velocity.x, z: velocity.z };
  for (let pass = 0; pass < 3; pass++) {
    for (const n of wallNormals) {
      const into = v.x * n.x + v.z * n.z;
      if (into < 0) {
        v = { x: v.x - into * n.x, z: v.z - into * n.z };
      }
    }
  }
  const stillBlocked = wallNormals.some((n) => v.x * n.x + v.z * n.z < -1e-6);
  return stillBlocked ? { x: 0, z: 0 } : v;
}
