/** 範例谷地的地形高度函式：起伏丘陵、蜿蜒河谷、四周山脈。 */

function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, z: number): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < 4; i++) {
    total += (valueNoise(x * frequency, z * frequency) - 0.5) * amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const HALF_SIZE = 128;
export const PLAYABLE_HALF = 108;

/** 河道中心線的 x 座標 */
export function riverX(z: number): number {
  return 14 * Math.sin(z / 45);
}

export function riverInfluence(x: number, z: number): number {
  const d = (x - riverX(z)) / 13;
  return Math.exp(-d * d);
}

/** 地形高度（公尺）。 */
export function terrainHeight(x: number, z: number): number {
  const hills = fbm(x / 55, z / 55) * 9;
  const river = riverInfluence(x, z) * -4.5;
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const mountains = smoothstep(PLAYABLE_HALF - 15, HALF_SIZE, edge) * (22 + fbm(x / 20, z / 20) * 10);
  // 據點與出生區附近壓平，方便建置
  let flatten = 0;
  for (const [fx, fz, r] of FLAT_AREAS) {
    const k = smoothstep(r + 10, r, Math.hypot(x - fx, z - fz));
    flatten = Math.max(flatten, k);
  }
  const base = hills + river + mountains;
  return base * (1 - flatten * 0.85);
}

/** 需要比較平坦的區域 [x, z, 半徑] */
export const FLAT_AREAS: ReadonlyArray<readonly [number, number, number]> = [
  [-55, -60, 14], // A 北哨站
  [60, 45, 22], // C 村落
  [0, 88, 16], // Alpha 出生區
  [0, -88, 16], // Bravo 出生區
];

export function terrainSlope(x: number, z: number): number {
  const e = 0.5;
  const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
  const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
  return Math.atan(Math.hypot(dx, dz));
}

/** 地形頂點色：草地、河岸泥土、陡坡岩石 */
export function terrainColor(x: number, z: number, y: number): [number, number, number] {
  const slope = terrainSlope(x, z);
  const n = valueNoise(x / 6, z / 6) * 0.12;
  const grass: [number, number, number] = [0.2 + n, 0.3 + n, 0.12];
  const dirt: [number, number, number] = [0.33 + n, 0.27 + n, 0.18];
  const rockC: [number, number, number] = [0.36 + n, 0.35 + n, 0.33 + n];
  const river = riverInfluence(x, z);
  let c = grass;
  const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  c = mix(c, dirt, smoothstep(0.35, 0.8, river));
  c = mix(c, rockC, smoothstep(0.45, 0.8, slope) + smoothstep(10, 20, y) * 0.6);
  return c;
}
