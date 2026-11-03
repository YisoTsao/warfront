import { describe, expect, it } from 'vitest';
import { MOVEMENT } from './constants';
import {
  canSprint,
  horizontalNormal,
  isWalkableNormal,
  resolveBlockedVelocity,
  resolveLocomotion,
  resolveStance,
  stepHorizontalVelocity,
  stepVerticalVelocity,
  targetSpeed,
  wishDirection,
} from './movement';

const noInput = { forward: 0, right: 0, sprint: false };

describe('wishDirection', () => {
  it('yaw 為 0 時向前是 -Z、向右是 +X', () => {
    const fwd = wishDirection({ ...noInput, forward: 1 }, 0);
    expect(fwd.x).toBeCloseTo(0);
    expect(fwd.z).toBeCloseTo(-1);
    const right = wishDirection({ ...noInput, right: 1 }, 0);
    expect(right.x).toBeCloseTo(1);
    expect(right.z).toBeCloseTo(0);
  });

  it('yaw 為 +90 度時向前變成 -X', () => {
    const fwd = wishDirection({ ...noInput, forward: 1 }, Math.PI / 2);
    expect(fwd.x).toBeCloseTo(-1);
    expect(fwd.z).toBeCloseTo(0);
  });

  it('斜向移動長度不超過 1', () => {
    const diag = wishDirection({ ...noInput, forward: 1, right: 1 }, 0.3);
    expect(Math.hypot(diag.x, diag.z)).toBeCloseTo(1);
  });
});

describe('canSprint', () => {
  it('站姿往前可以衝刺', () => {
    expect(canSprint({ forward: 1, right: 0, sprint: true }, 'standing')).toBe(true);
  });

  it('往前加側移（45 度）仍可衝刺，純側移與後退不行', () => {
    expect(canSprint({ forward: 1, right: 1, sprint: true }, 'standing')).toBe(true);
    expect(canSprint({ forward: 0, right: 1, sprint: true }, 'standing')).toBe(false);
    expect(canSprint({ forward: -1, right: 0, sprint: true }, 'standing')).toBe(false);
  });

  it('蹲姿或沒按衝刺不能衝刺', () => {
    expect(canSprint({ forward: 1, right: 0, sprint: true }, 'crouching')).toBe(false);
    expect(canSprint({ forward: 1, right: 0, sprint: false }, 'standing')).toBe(false);
  });
});

describe('targetSpeed', () => {
  it('依姿勢與衝刺回傳對應速度', () => {
    expect(targetSpeed('standing', false)).toBe(MOVEMENT.walkSpeed);
    expect(targetSpeed('standing', true)).toBe(MOVEMENT.sprintSpeed);
    expect(targetSpeed('crouching', true)).toBe(MOVEMENT.crouchSpeed);
  });
});

describe('stepHorizontalVelocity', () => {
  const dt = 1 / 60;

  it('地面上會逐步加速到目標速度且不超過', () => {
    let v = { x: 0, z: 0 };
    for (let i = 0; i < 120; i++) {
      v = stepHorizontalVelocity(v, { x: 0, z: -1 }, MOVEMENT.walkSpeed, true, dt);
    }
    expect(v.z).toBeCloseTo(-MOVEMENT.walkSpeed);
    expect(v.x).toBeCloseTo(0);
  });

  it('單步加速量受加速度限制', () => {
    const v = stepHorizontalVelocity({ x: 0, z: 0 }, { x: 1, z: 0 }, MOVEMENT.sprintSpeed, true, dt);
    expect(v.x).toBeCloseTo(MOVEMENT.groundAcceleration * dt);
  });

  it('地面上放開按鍵會減速到停止', () => {
    let v = { x: 3, z: 0 };
    for (let i = 0; i < 60; i++) {
      v = stepHorizontalVelocity(v, { x: 0, z: 0 }, MOVEMENT.walkSpeed, true, dt);
    }
    expect(v.x).toBe(0);
  });

  it('空中沒有輸入時保持慣性，有輸入時只有部分控制力', () => {
    const coasting = stepHorizontalVelocity({ x: 3, z: 0 }, { x: 0, z: 0 }, MOVEMENT.walkSpeed, false, dt);
    expect(coasting.x).toBe(3);
    const steering = stepHorizontalVelocity({ x: 0, z: 0 }, { x: 1, z: 0 }, MOVEMENT.walkSpeed, false, dt);
    expect(steering.x).toBeCloseTo(MOVEMENT.groundAcceleration * MOVEMENT.airControl * dt);
  });
});

describe('stepVerticalVelocity', () => {
  const dt = 1 / 60;

  it('在地面上按跳躍會起跳', () => {
    const r = stepVerticalVelocity(0, true, true, 'standing', dt);
    expect(r.jumped).toBe(true);
    expect(r.velocityY).toBe(MOVEMENT.jumpVelocity);
  });

  it('空中按跳躍不會再次起跳', () => {
    const r = stepVerticalVelocity(1, false, true, 'standing', dt);
    expect(r.jumped).toBe(false);
    expect(r.velocityY).toBeCloseTo(1 - MOVEMENT.gravity * dt);
  });

  it('蹲姿不能跳', () => {
    expect(stepVerticalVelocity(0, true, true, 'crouching', dt).jumped).toBe(false);
  });

  it('落地時清除向下速度，下落速度有上限', () => {
    expect(stepVerticalVelocity(-5, true, false, 'standing', dt).velocityY).toBe(0);
    expect(stepVerticalVelocity(-MOVEMENT.maxFallSpeed, false, false, 'standing', dt).velocityY).toBe(
      -MOVEMENT.maxFallSpeed,
    );
  });

  it('跳躍高度約 0.74 公尺', () => {
    let vy: number = MOVEMENT.jumpVelocity;
    let y = 0;
    let peak = 0;
    while (vy > -MOVEMENT.jumpVelocity) {
      y += vy * dt;
      peak = Math.max(peak, y);
      vy = stepVerticalVelocity(vy, false, false, 'standing', dt).velocityY;
    }
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThan(0.78);
  });
});

describe('resolveStance / resolveLocomotion', () => {
  it('頭頂空間不足時維持蹲姿', () => {
    expect(resolveStance(false, false)).toBe('crouching');
    expect(resolveStance(false, true)).toBe('standing');
    expect(resolveStance(true, true)).toBe('crouching');
  });

  it('依地面、速度與衝刺推導移動狀態', () => {
    expect(resolveLocomotion(false, 5, true)).toBe('airborne');
    expect(resolveLocomotion(true, 0, false)).toBe('idle');
    expect(resolveLocomotion(true, 3, false)).toBe('walking');
    expect(resolveLocomotion(true, 6, true)).toBe('sprinting');
  });
});

describe('isWalkableNormal / horizontalNormal', () => {
  const normalForSlope = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: 0, y: Math.cos(a), z: Math.sin(a) };
  };

  it('不超過爬坡上限的坡面可行走，更陡的視為牆', () => {
    expect(isWalkableNormal({ x: 0, y: 1, z: 0 })).toBe(true);
    expect(isWalkableNormal(normalForSlope(40))).toBe(true);
    expect(isWalkableNormal(normalForSlope(55))).toBe(false);
    expect(isWalkableNormal({ x: 1, y: 0, z: 0 })).toBe(false);
  });

  it('水平法線會被正規化，垂直法線沒有水平方向', () => {
    const n = horizontalNormal(normalForSlope(60));
    expect(n?.x).toBeCloseTo(0);
    expect(n?.z).toBeCloseTo(1);
    expect(horizontalNormal({ x: 0, y: -1, z: 0 })).toBeNull();
  });
});

describe('resolveBlockedVelocity', () => {
  it('沒有牆時速度不變', () => {
    expect(resolveBlockedVelocity({ x: 1, z: -2 }, [])).toEqual({ x: 1, z: -2 });
  });

  it('正面撞牆時停下', () => {
    const v = resolveBlockedVelocity({ x: 0, z: -3 }, [{ x: 0, z: 1 }]);
    expect(v.x).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(0);
  });

  it('斜向撞牆時沿牆滑動', () => {
    const v = resolveBlockedVelocity({ x: 2, z: -2 }, [{ x: 0, z: 1 }]);
    expect(v.x).toBeCloseTo(2);
    expect(v.z).toBeCloseTo(0);
  });

  it('離開牆面的速度不受影響', () => {
    expect(resolveBlockedVelocity({ x: 0, z: 3 }, [{ x: 0, z: 1 }])).toEqual({ x: 0, z: 3 });
  });

  it('兩面牆夾出的通道內仍可沿通道前進', () => {
    const v = resolveBlockedVelocity({ x: 1, z: -3 }, [
      { x: 1, z: 0 },
      { x: -1, z: 0 },
    ]);
    expect(v.x).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(-3);
  });

  it('推進銳角牆角時水平速度歸零', () => {
    const a = (30 * Math.PI) / 180;
    // 牆 A 法線朝 +Z；牆 B 與牆 A 夾 30°，法線朝 (-sin a, -cos a)。
    const v = resolveBlockedVelocity({ x: 3, z: 0.5 }, [
      { x: 0, z: 1 },
      { x: -Math.sin(a), z: -Math.cos(a) },
    ]);
    expect(v).toEqual({ x: 0, z: 0 });
  });
});
