import { describe, expect, it } from 'vitest';
import { horizontalToVerticalFov } from './fov';

describe('horizontalToVerticalFov', () => {
  it('16:9 下水平 90 度約為垂直 58.7 度', () => {
    expect(horizontalToVerticalFov(90, 16 / 9)).toBeCloseTo(58.72, 1);
  });

  it('長寬比 1 時水平與垂直相同', () => {
    expect(horizontalToVerticalFov(75, 1)).toBeCloseTo(75);
  });
});
