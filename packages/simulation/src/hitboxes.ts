import type { Stance, Vec3 } from '@frontline/shared';

export type HitZone = 'head' | 'torso' | 'limb';

interface CapsulePart {
  zone: HitZone;
  a: Vec3;
  b: Vec3;
  radius: number;
}

export interface HitboxPose {
  feet: Vec3;
  yaw: number;
  stance: Stance;
}

/**
 * 伺服器端命中判定用的 hitbox：頭（球）、軀幹、腿（膠囊）。
 * 數值以 1.84 m 身高的士兵估算；臥倒時沿面向方向躺平。
 */
export function hitboxParts(pose: HitboxPose): CapsulePart[] {
  const { feet: f, yaw, stance } = pose;
  const at = (forward: number, up: number): Vec3 => ({
    x: f.x - Math.sin(yaw) * forward,
    y: f.y + up,
    z: f.z - Math.cos(yaw) * forward,
  });
  switch (stance) {
    case 'prone':
      return [
        { zone: 'head', a: at(0.75, 0.3), b: at(0.75, 0.3), radius: 0.13 },
        { zone: 'torso', a: at(0.45, 0.22), b: at(-0.15, 0.22), radius: 0.2 },
        { zone: 'limb', a: at(-0.25, 0.15), b: at(-1.0, 0.12), radius: 0.15 },
      ];
    case 'crouching':
      return [
        { zone: 'head', a: at(0.05, 1.02), b: at(0.05, 1.02), radius: 0.13 },
        { zone: 'torso', a: at(0.05, 0.55), b: at(0.05, 0.85), radius: 0.22 },
        { zone: 'limb', a: at(0, 0.12), b: at(0, 0.45), radius: 0.2 },
      ];
    default:
      return [
        { zone: 'head', a: at(0, 1.64), b: at(0, 1.64), radius: 0.13 },
        { zone: 'torso', a: at(0, 1.0), b: at(0, 1.42), radius: 0.22 },
        { zone: 'limb', a: at(0, 0.12), b: at(0, 0.92), radius: 0.17 },
      ];
  }
}

/** 包住所有 hitbox 的球，先用它快速排除。 */
export function hitboxBounds(pose: HitboxPose): { center: Vec3; radius: number } {
  return { center: { x: pose.feet.x, y: pose.feet.y + 0.9, z: pose.feet.z }, radius: 1.3 };
}

/** 射線與膠囊（線段 + 半徑）的最近交點距離；沒有交點回傳 null。 */
export function intersectRayCapsule(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, radius: number, maxDistance: number): number | null {
  // 以取樣 + 二分逼近的穩定做法：先算射線到線段的最近距離，再沿射線求進入點。
  const segment = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const distanceAt = (t: number): number => {
    const p = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
    const len2 = segment.x * segment.x + segment.y * segment.y + segment.z * segment.z;
    let s = 0;
    if (len2 > 1e-12) {
      s = ((p.x - a.x) * segment.x + (p.y - a.y) * segment.y + (p.z - a.z) * segment.z) / len2;
      s = Math.max(0, Math.min(1, s));
    }
    const q = { x: a.x + segment.x * s, y: a.y + segment.y * s, z: a.z + segment.z * s };
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  };
  // 射線上離線段中點最近的參數作為搜尋中心
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const tMid = (mid.x - origin.x) * dir.x + (mid.y - origin.y) * dir.y + (mid.z - origin.z) * dir.z;
  const halfLength = Math.hypot(segment.x, segment.y, segment.z) / 2 + radius;
  let lo = Math.max(0, tMid - halfLength - radius);
  let hi = Math.min(maxDistance, tMid + halfLength + radius);
  if (hi < lo) {
    return null;
  }
  // 找到範圍內的最小距離點
  let best = lo;
  let bestDistance = Number.POSITIVE_INFINITY;
  const samples = 24;
  for (let i = 0; i <= samples; i++) {
    const t = lo + ((hi - lo) * i) / samples;
    const d = distanceAt(t);
    if (d < bestDistance) {
      bestDistance = d;
      best = t;
    }
  }
  if (bestDistance > radius) {
    return null;
  }
  // 在 [lo, best] 之間二分出進入點
  hi = best;
  if (distanceAt(lo) <= radius) {
    return lo;
  }
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (distanceAt(m) <= radius) {
      hi = m;
    } else {
      lo = m;
    }
  }
  return hi;
}

export interface HitboxHit {
  zone: HitZone;
  distance: number;
}

/** 射線打到這個姿勢的哪一個部位（最近的那一個）。 */
export function raycastHitbox(pose: HitboxPose, origin: Vec3, dir: Vec3, maxDistance: number): HitboxHit | null {
  const bounds = hitboxBounds(pose);
  const toCenter = { x: bounds.center.x - origin.x, y: bounds.center.y - origin.y, z: bounds.center.z - origin.z };
  const along = toCenter.x * dir.x + toCenter.y * dir.y + toCenter.z * dir.z;
  if (along < -bounds.radius || along > maxDistance + bounds.radius) {
    return null;
  }
  const closest = Math.hypot(toCenter.x - dir.x * along, toCenter.y - dir.y * along, toCenter.z - dir.z * along);
  if (closest > bounds.radius) {
    return null;
  }
  let best: HitboxHit | null = null;
  for (const part of hitboxParts(pose)) {
    const distance = intersectRayCapsule(origin, dir, part.a, part.b, part.radius, maxDistance);
    if (distance !== null && (!best || distance < best.distance)) {
      best = { zone: part.zone, distance };
    }
  }
  return best;
}
