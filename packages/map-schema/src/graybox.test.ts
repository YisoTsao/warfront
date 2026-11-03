import { describe, expect, it } from 'vitest';
import { parseMapCollision } from './collision';
import { boxRotationQuaternion, grayboxCollision, grayboxManifest } from './graybox';
import { parseMapManifest } from './manifest';

describe('graybox map', () => {
  it('manifest 與碰撞資料通過 schema 驗證', () => {
    expect(() => parseMapManifest(grayboxManifest())).not.toThrow();
    expect(() => parseMapCollision(grayboxCollision())).not.toThrow();
  });

  it('兩隊各有出生點', () => {
    const spawns = grayboxManifest().spawns;
    expect(spawns.filter((s) => s.team === 'alpha').length).toBeGreaterThanOrEqual(5);
    expect(spawns.filter((s) => s.team === 'bravo').length).toBeGreaterThanOrEqual(5);
  });

  it('旋轉四元數為單位長度，單軸旋轉正確', () => {
    const q = boxRotationQuaternion({ rotationX: 0.5, rotationY: 1.2 });
    expect(Math.hypot(...q)).toBeCloseTo(1);
    const qx = boxRotationQuaternion({ rotationX: Math.PI / 2 });
    expect(qx[0]).toBeCloseTo(Math.SQRT1_2);
    expect(qx[3]).toBeCloseTo(Math.SQRT1_2);
  });
});
