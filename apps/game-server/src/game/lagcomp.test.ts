import { describe, expect, it } from 'vitest';
import { LagCompensation, type PoseRecord } from './LagCompensation';

const pose = (x: number): Map<number, PoseRecord> => new Map([[1, { feet: { x, y: 0, z: 0 }, yaw: 0, stance: 'standing', hittable: true }]]);

describe('LagCompensation', () => {
  it('請求目前 tick（尚未記錄）時取上一個 tick', () => {
    const lag = new LagCompensation();
    lag.record(10, pose(10));
    expect(lag.posesAt(11, 11)?.tick).toBe(10);
  });

  it('回溯到指定 tick，超過上限時夾在最舊可回溯的紀錄', () => {
    const lag = new LagCompensation();
    for (let t = 0; t <= 30; t++) {
      lag.record(t, pose(t));
    }
    expect(lag.posesAt(25, 30)?.tick).toBe(25);
    const clamped = lag.posesAt(0, 30)!;
    expect(clamped.tick).toBeGreaterThanOrEqual(30 - 8);
  });

  it('沒有任何紀錄時回傳 null', () => {
    expect(new LagCompensation().posesAt(5, 5)).toBeNull();
  });
});
