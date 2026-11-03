import { describe, expect, it } from 'vitest';
import { parseMapCollision } from './collision';
import { grayboxManifest } from './graybox';
import { horizontalDistanceToBounds, parseMapManifest, pointInBounds } from './manifest';
import { matchRole, parseLodName, roleCategory } from './markers';

describe('parseMapManifest', () => {
  it('缺少出生點時回報欄位路徑', () => {
    const bad = { ...grayboxManifest(), spawns: [] };
    expect(() => parseMapManifest(bad)).toThrow(/spawns/);
  });

  it('id 只能用小寫英數與連字號', () => {
    expect(() => parseMapManifest({ ...grayboxManifest(), id: 'Black Wood' })).toThrow(/id/);
  });
});

describe('parseMapCollision', () => {
  it('拒絕索引超出頂點範圍的三角網格', () => {
    const bad = { schemaVersion: 1, colliders: [{ kind: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 3] }] };
    expect(() => parseMapCollision(bad)).toThrow(/索引/);
  });

  it('補上預設的碰撞層與旋轉', () => {
    const parsed = parseMapCollision({ schemaVersion: 1, colliders: [{ kind: 'box', center: [0, 0, 0], halfExtents: [1, 1, 1] }] });
    const box = parsed.colliders[0];
    expect(box?.layer).toBe('both');
    expect(box?.kind === 'box' && box.rotation).toEqual([0, 0, 0, 1]);
  });
});

describe('bounds helpers', () => {
  const b = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };
  it('判斷點是否在範圍內', () => {
    expect(pointInBounds([5, 5, 5], b)).toBe(true);
    expect(pointInBounds({ x: 11, y: 5, z: 5 }, b)).toBe(false);
  });
  it('計算水平距離', () => {
    expect(horizontalDistanceToBounds(5, 5, b)).toBe(0);
    expect(horizontalDistanceToBounds(13, 14, b)).toBeCloseTo(5);
  });
});

describe('Blender 命名慣例', () => {
  it('依名稱前綴與自訂屬性判斷角色', () => {
    expect(matchRole('ENV_Trees')).toBe('ENV_Trees');
    expect(matchRole('COLLISION_Static.001')).toBe('COLLISION_Static');
    expect(matchRole('Rock_12')).toBeNull();
    expect(matchRole('Anything', { frontline_role: 'GAMEPLAY_SpawnPoints' })).toBe('GAMEPLAY_SpawnPoints');
    expect(roleCategory('ENV_Rocks')).toBe('visual');
    expect(roleCategory('COLLISION_Bullet')).toBe('collision');
    expect(roleCategory('LIGHTING_Reference')).toBe('ignored');
  });

  it('解析 LOD 名稱', () => {
    expect(parseLodName('Pine_LOD1')).toEqual({ base: 'Pine', level: 1 });
    expect(parseLodName('Pine')).toBeNull();
  });
});
