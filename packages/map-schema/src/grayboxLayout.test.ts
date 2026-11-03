import { describe, expect, it } from 'vitest';
import { GRAYBOX_LAYOUT, TUNNEL_CLEARANCE, ramp, stairs } from './grayboxLayout';

describe('ramp', () => {
  it('坡道頂端高度等於 length × sin(角度)，平台與頂端同高', () => {
    const [slope, platform] = ramp('r', 30, 8, 4, 0, 0);
    expect(slope).toBeDefined();
    expect(platform).toBeDefined();
    const rise = 8 * Math.sin(Math.PI / 6);
    expect(platform!.size[1]).toBeCloseTo(rise);
    expect(platform!.position[1] + platform!.size[1] / 2).toBeCloseTo(rise);
  });

  it('坡道上表面的低端落在地面（y = 0, z = zStart）', () => {
    const angle = Math.PI / 4;
    const [slope] = ramp('r', 45, 6, 4, 0, 2);
    const [, cy, cz] = slope!.position;
    const t = slope!.size[1];
    const l = slope!.size[2];
    // 上表面中點 = 中心 + 法線 × t/2；低端 = 上表面中點 - 坡向 × l/2
    const topMidY = cy + (Math.cos(angle) * t) / 2;
    const topMidZ = cz + (Math.sin(angle) * t) / 2;
    expect(topMidY - (Math.sin(angle) * l) / 2).toBeCloseTo(0);
    expect(topMidZ + (Math.cos(angle) * l) / 2).toBeCloseTo(2);
  });
});

describe('stairs', () => {
  it('每一階高度遞增，平台與最後一階同高', () => {
    const boxes = stairs('s', 4, 0.2, 0.3, 2, 0, 0);
    const tops = boxes.map((b) => b.position[1] + b.size[1] / 2);
    expect(tops.slice(0, 4)).toEqual([0.2, 0.4, 0.6000000000000001, 0.8]);
    expect(tops[4]).toBeCloseTo(0.8);
  });
});

describe('GRAYBOX_LAYOUT', () => {
  it('所有方塊尺寸為正、名稱不重複', () => {
    const names = new Set<string>();
    for (const box of GRAYBOX_LAYOUT.boxes) {
      expect(box.size.every((s) => s > 0)).toBe(true);
      expect(names.has(box.name)).toBe(false);
      names.add(box.name);
    }
  });

  it('通道淨高介於蹲姿（1.2 m）與站姿（1.84 m）高度之間', () => {
    expect(TUNNEL_CLEARANCE).toBeGreaterThan(1.2);
    expect(TUNNEL_CLEARANCE).toBeLessThan(1.84);
  });

  it('出生點在地圖範圍內且高於回收高度', () => {
    const [x, y, z] = GRAYBOX_LAYOUT.spawn.feet;
    expect(Math.abs(x)).toBeLessThan(60);
    expect(Math.abs(z)).toBeLessThan(60);
    expect(y).toBeGreaterThan(GRAYBOX_LAYOUT.killPlaneY);
  });
});
