import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from './FixedStepLoop';

describe('FixedStepLoop', () => {
  it('依累積時間執行整數個固定步，並回傳插值係數', () => {
    const loop = new FixedStepLoop(0.01, 10);
    let steps = 0;
    const alpha = loop.advance(0.025, () => steps++);
    expect(steps).toBe(2);
    expect(alpha).toBeCloseTo(0.5);
  });

  it('剩餘時間會累積到下一個畫格', () => {
    const loop = new FixedStepLoop(0.01, 10);
    let steps = 0;
    loop.advance(0.006, () => steps++);
    loop.advance(0.006, () => steps++);
    expect(steps).toBe(1);
  });

  it('單一畫格步數有上限，落後的時間會被丟棄', () => {
    const loop = new FixedStepLoop(0.01, 4);
    let steps = 0;
    const alpha = loop.advance(1, () => steps++);
    expect(steps).toBe(4);
    expect(alpha).toBe(0);
    loop.advance(0.005, () => steps++);
    expect(steps).toBe(4);
  });

  it('負的時間差不會倒退', () => {
    const loop = new FixedStepLoop(0.01, 4);
    let steps = 0;
    loop.advance(-1, () => steps++);
    expect(steps).toBe(0);
  });
});
