import { cross3, normalize3, type Vec3 } from './vec3';

/** 把多個整數雜湊成一個 32 位元種子（兩端算出相同結果）。 */
export function hashSeed(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    let v = Math.trunc(value) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  // 最後再攪拌一次
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 把字串（例如玩家 id）雜湊成整數。 */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：快速、可重現的 32 位元亂數產生器，回傳 [0, 1)。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在以 direction 為軸、半角 halfAngle（弧度）的圓錐內均勻取一個方向。 */
export function randomInCone(rng: () => number, direction: Vec3, halfAngle: number): Vec3 {
  const axis = normalize3(direction);
  if (halfAngle <= 0) {
    return axis;
  }
  const cosMax = Math.cos(halfAngle);
  const cosTheta = 1 - rng() * (1 - cosMax);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = rng() * Math.PI * 2;
  const helper = Math.abs(axis.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize3(cross3(helper, axis));
  const v = cross3(axis, u);
  return normalize3({
    x: axis.x * cosTheta + (u.x * Math.cos(phi) + v.x * Math.sin(phi)) * sinTheta,
    y: axis.y * cosTheta + (u.y * Math.cos(phi) + v.y * Math.sin(phi)) * sinTheta,
    z: axis.z * cosTheta + (u.z * Math.cos(phi) + v.z * Math.sin(phi)) * sinTheta,
  });
}
