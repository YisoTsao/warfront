/** 把水平視野（度）換算成 Three.js PerspectiveCamera 使用的垂直視野（度）。 */
export function horizontalToVerticalFov(horizontalDegrees: number, aspect: number): number {
  const h = (horizontalDegrees * Math.PI) / 180;
  const v = 2 * Math.atan(Math.tan(h / 2) / Math.max(aspect, 1e-3));
  return (v * 180) / Math.PI;
}
