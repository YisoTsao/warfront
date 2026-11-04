/**
 * 讀取 blender-mcp-asset-generator 的輸出（output/phase1_terrain … phase5_environment）。
 *
 * 座標：Blender 為 Z 朝上、+Y 為北；warfront（glTF）為 Y 朝上、北方為 −Z。
 *   warfront (X, Y, Z) = (x, z, −y)
 * 高度圖的第 0 列是北邊（y = +size/2），第 0 欄是西邊（x = −size/2）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export type V2 = [number, number];
export type V3 = [number, number, number];

/** 正方形高度／遮罩格網，以 Blender 平面座標取樣。 */
export class Grid {
  readonly cell: number;
  readonly half: number;

  constructor(
    readonly data: Float32Array,
    readonly res: number,
    readonly size: number,
  ) {
    this.cell = size / (res - 1);
    this.half = size / 2;
  }

  at(row: number, col: number): number {
    const r = Math.min(this.res - 1, Math.max(0, row));
    const c = Math.min(this.res - 1, Math.max(0, col));
    return this.data[r * this.res + c]!;
  }

  /** 雙線性取樣；x、y 為 Blender 平面座標（公尺）。 */
  sample(x: number, y: number): number {
    const fc = (x + this.half) / this.cell;
    const fr = (this.half - y) / this.cell;
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const tc = fc - c0;
    const tr = fr - r0;
    const a = this.at(r0, c0) * (1 - tc) + this.at(r0, c0 + 1) * tc;
    const b = this.at(r0 + 1, c0) * (1 - tc) + this.at(r0 + 1, c0 + 1) * tc;
    return a * (1 - tr) + b * tr;
  }

  /** 坡度（度），以中央差分計算。 */
  slopeDegrees(x: number, y: number): number {
    const d = this.cell;
    const gx = (this.sample(x + d, y) - this.sample(x - d, y)) / (2 * d);
    const gy = (this.sample(x, y + d) - this.sample(x, y - d)) / (2 * d);
    return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
  }
}

export function toWorld(x: number, y: number, z: number): V3 {
  return [x, z, -y];
}

/** 讀取 16 位元小端序 raw 高度圖（.r16），依 value_0 / value_65535 換算成公尺。 */
export function readR16(path: string, lo: number, hi: number, size: number): Grid {
  const buffer = readFileSync(path);
  const count = buffer.byteLength / 2;
  const res = Math.round(Math.sqrt(count));
  if (res * res !== count) {
    throw new Error(`${path} 不是正方形高度圖（${count} 個樣本）`);
  }
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = lo + (buffer.readUInt16LE(i * 2) / 65535) * (hi - lo);
  }
  return new Grid(data, res, size);
}

/** 讀取灰階 PNG 的第一個通道，換算成 0–1（16 位元圖乘上 scale 可得實際值）。 */
export async function readMask(path: string, size: number, scale = 1): Promise<Grid> {
  const image = sharp(path);
  const meta = await image.metadata();
  const sixteen = meta.depth === 'ushort';
  // 不指定色彩空間時 sharp 會把 16 位元灰階轉成 8 位元 sRGB
  const { data, info } = await image
    .toColourspace(sixteen ? 'grey16' : 'b-w')
    .raw({ depth: sixteen ? 'ushort' : 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.width !== info.height) {
    throw new Error(`${path} 不是正方形遮罩`);
  }
  const values = sixteen ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2) : data;
  const max = sixteen ? 65535 : 255;
  const out = new Float32Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (values[i * info.channels]! / max) * scale;
  }
  return new Grid(out, info.width, size);
}

export interface InstanceSet {
  assets: string[];
  /** 每列：x_cm, y_cm, z_cm, rot_x_deg, rot_y_deg, rot_z_deg, scale, variant（岩石另有 moss、wet） */
  instances: number[][];
}

export interface Site {
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  yaw_deg: number;
}

export interface LayoutCollider {
  type: 'box' | 'capsule';
  center_m: V3;
  /** box：[x, y, z] 尺寸；capsule：[半徑, 長度] */
  size_m: number[];
  yaw_deg: number;
}

export interface Layout {
  sites: Record<string, Site>;
  bridge: { deck_z_m: number; span_m: number; width_m: number; abutments_xy_m: [V2, V2] };
  roads: Record<string, { half_width_m: number; kind: string; polyline_xyz_m: V3[] }>;
  trench: { polyline_xy_m: V2[] };
  hq_spawn_hints_m: Record<string, V3[]>;
  structures: Array<{ name: string; site: string; location_m: V3; yaw_deg: number; colliders: LayoutCollider[] }>;
}

export interface ForestSources {
  dir: string;
  size: number;
  /** 河道雕刻後的地形（植被與岩石擺放時的地面） */
  carved: Grid;
  /** 第 5 階段整地後的最終地形（道路、營地、壕溝） */
  graded: Grid;
  waterMask: Grid;
  /** 水深（公尺） */
  waterDepth: Grid;
  density: Record<'grass' | 'moss' | 'needle' | 'leaf' | 'canopy' | 'scree', Grid>;
  vegetation: Record<string, InstanceSet>;
  rocks: Record<string, InstanceSet>;
  layout: Layout;
  files: { water: string; vegetation: string; rocks: string; structures: string };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export async function readForestSources(dir: string): Promise<ForestSources> {
  const p = (...parts: string[]) => join(dir, ...parts);
  const terrainMeta = readJson<{ config: { size_m: number } }>(p('phase1_terrain', 'terrain_meta.json'));
  const size = terrainMeta.config.size_m;
  const water = readJson<{ heightmap_carved: { value_0_m: number; value_65535_m: number }; water_depth_map: { value_65535_m: number } }>(
    p('phase2_water', 'water_bodies.json'),
  );
  const env = readJson<{ heightmap_graded: { value_0_m: number; value_65535_m: number } }>(p('phase5_environment', 'environment_meta.json'));
  const carved = readR16(p('phase2_water', 'heightmap_carved_1025.r16'), water.heightmap_carved.value_0_m, water.heightmap_carved.value_65535_m, size);
  const graded = readR16(p('phase5_environment', 'heightmap_graded_1025.r16'), env.heightmap_graded.value_0_m, env.heightmap_graded.value_65535_m, size);
  const veg = (name: string) => readMask(p('phase3_vegetation', `density_${name}_513.png`), size);
  const [waterMask, waterDepth, grass, moss, needle, leaf, canopy, scree] = await Promise.all([
    readMask(p('phase2_water', 'water_mask_1025.png'), size),
    readMask(p('phase2_water', 'water_depth_1025_16bit.png'), size, water.water_depth_map.value_65535_m),
    veg('grass'),
    veg('moss'),
    veg('litter_needle'),
    veg('litter_leaf'),
    veg('canopy'),
    readMask(p('phase4_rocks', 'scree_513.png'), size),
  ]);
  return {
    dir,
    size,
    carved,
    graded,
    waterMask,
    waterDepth,
    density: { grass, moss, needle, leaf, canopy, scree },
    vegetation: readJson(p('phase3_vegetation', 'vegetation_instances.json')),
    rocks: readJson(p('phase4_rocks', 'rock_instances.json')),
    layout: readJson(p('phase5_environment', 'environment_layout.json')),
    files: {
      water: p('phase2_water', 'water_meshes.glb'),
      vegetation: p('phase3_vegetation', 'vegetation_assets.glb'),
      rocks: p('phase4_rocks', 'rock_assets.glb'),
      structures: p('phase5_environment', 'structures.glb'),
    },
  };
}
