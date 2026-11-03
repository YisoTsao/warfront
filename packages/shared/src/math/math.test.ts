import { describe, expect, it } from 'vitest';
import { createRng, hashSeed, hashString, randomInCone } from './random';
import { angleDifference, directionFromYawPitch, dot3 } from './vec3';

describe('random', () => {
  it('相同種子產生相同序列', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(createRng(43)()).not.toBe(createRng(42)());
  });

  it('hashSeed 對輸入敏感且可重現', () => {
    expect(hashSeed(1, 2, 3)).toBe(hashSeed(1, 2, 3));
    expect(hashSeed(1, 2, 3)).not.toBe(hashSeed(1, 2, 4));
    expect(hashString('abc')).toBe(hashString('abc'));
  });

  it('圓錐取樣落在半角內', () => {
    const rng = createRng(7);
    const axis = { x: 0, y: 0, z: -1 };
    const half = (3 * Math.PI) / 180;
    for (let i = 0; i < 500; i++) {
      const d = randomInCone(rng, axis, half);
      expect(dot3(d, axis)).toBeGreaterThanOrEqual(Math.cos(half) - 1e-9);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1);
    }
  });
});

describe('vec3', () => {
  it('yaw/pitch 轉視線方向與相機慣例一致', () => {
    const forward = directionFromYawPitch(0, 0);
    expect(forward.z).toBeCloseTo(-1);
    const up = directionFromYawPitch(0, Math.PI / 2);
    expect(up.y).toBeCloseTo(1);
    const left = directionFromYawPitch(Math.PI / 2, 0);
    expect(left.x).toBeCloseTo(-1);
  });

  it('角度差值落在 -π 到 π', () => {
    expect(angleDifference(0.1, 2 * Math.PI)).toBeCloseTo(0.1);
    expect(angleDifference(-3, 3)).toBeCloseTo(2 * Math.PI - 6);
  });
});
