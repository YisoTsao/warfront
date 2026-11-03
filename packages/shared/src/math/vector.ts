/** 水平面向量（Y 軸朝上，只取 X 與 Z）。單位一律為公尺或公尺／秒。 */
export interface Vec2 {
  x: number;
  z: number;
}

export function length2(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 讓 current 以最多 maxDelta 的距離朝 target 前進，不會超過 target。 */
export function moveTowards(current: Vec2, target: Vec2, maxDelta: number): Vec2 {
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxDelta || distance === 0) {
    return { x: target.x, z: target.z };
  }
  const scale = maxDelta / distance;
  return { x: current.x + dx * scale, z: current.z + dz * scale };
}
