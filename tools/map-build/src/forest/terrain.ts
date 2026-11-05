/**
 * 地形：由整地後的高度圖產生視覺分塊、碰撞高度場與大範圍底色貼圖。
 *
 * 視覺網格與碰撞高度場使用同一組樣本與同樣的三角切分
 * （對角線連接 (col+1, row) 與 (col, row+1)），玩家腳下與畫面完全一致。
 */
import type { Document, Material, Node } from '@gltf-transform/core';
import sharp from 'sharp';
import type { ForestSources, Grid, Layout, V2 } from './sources';

export interface TerrainSamples {
  /** 列優先；列沿 +Z（北→南），欄沿 +X（西→東） */
  heights: Float32Array;
  res: number;
  size: number;
}

/** 從 1025 高度圖每隔一個樣本取一次，得到約 1 m 間距的地形。 */
export function terrainSamples(graded: Grid, step = 2): TerrainSamples {
  const res = Math.floor((graded.res - 1) / step) + 1;
  const heights = new Float32Array(res * res);
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      heights[r * res + c] = Math.round(graded.at(r * step, c * step) * 1000) / 1000;
    }
  }
  return { heights, res, size: graded.size };
}

/** 與碰撞高度場相同的內插：x、z 為 warfront 座標。 */
export function terrainHeightAt(t: TerrainSamples, x: number, z: number): number {
  const cell = t.size / (t.res - 1);
  const fx = Math.min(t.res - 1, Math.max(0, (x + t.size / 2) / cell));
  const fz = Math.min(t.res - 1, Math.max(0, (z + t.size / 2) / cell));
  const c = Math.min(Math.floor(fx), t.res - 2);
  const r = Math.min(Math.floor(fz), t.res - 2);
  const u = fx - c;
  const v = fz - r;
  const h = t.heights;
  const h00 = h[r * t.res + c]!;
  const h10 = h[r * t.res + c + 1]!;
  const h01 = h[(r + 1) * t.res + c]!;
  const h11 = h[(r + 1) * t.res + c + 1]!;
  return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}

/** 地形視覺分塊：tiles × tiles 個網格，相鄰分塊共用邊界樣本。UV 對應整張地圖。 */
export function addTerrainTiles(doc: Document, parent: Node, t: TerrainSamples, material: Material, tiles: number): void {
  const buffer = doc.getRoot().listBuffers()[0]!;
  const cells = t.res - 1;
  const cell = t.size / cells;
  const per = Math.ceil(cells / tiles);
  const height = (r: number, c: number) => t.heights[r * t.res + c]!;
  for (let tr = 0; tr < tiles; tr++) {
    for (let tc = 0; tc < tiles; tc++) {
      const r0 = tr * per;
      const c0 = tc * per;
      const r1 = Math.min(cells, r0 + per);
      const c1 = Math.min(cells, c0 + per);
      const rows = r1 - r0 + 1;
      const cols = c1 - c0 + 1;
      const positions = new Float32Array(rows * cols * 3);
      const normals = new Float32Array(rows * cols * 3);
      const uvs = new Float32Array(rows * cols * 2);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = (r - r0) * cols + (c - c0);
          positions.set([-t.size / 2 + c * cell, height(r, c), -t.size / 2 + r * cell], i * 3);
          const dx = (height(r, Math.min(cells, c + 1)) - height(r, Math.max(0, c - 1))) / ((Math.min(cells, c + 1) - Math.max(0, c - 1)) * cell);
          const dz = (height(Math.min(cells, r + 1), c) - height(Math.max(0, r - 1), c)) / ((Math.min(cells, r + 1) - Math.max(0, r - 1)) * cell);
          const len = Math.hypot(dx, 1, dz);
          normals.set([-dx / len, 1 / len, -dz / len], i * 3);
          uvs.set([c / cells, r / cells], i * 2);
        }
      }
      const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);
      let k = 0;
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c; // (c, r)
          const b = a + 1; // (c+1, r)
          const d = a + cols; // (c, r+1)
          const e = d + 1; // (c+1, r+1)
          indices.set([a, d, b, b, d, e], k);
          k += 6;
        }
      }
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer))
        .setMaterial(material);
      const mesh = doc.createMesh(`Terrain_${tr}_${tc}`).addPrimitive(prim);
      parent.addChild(doc.createNode(`Terrain_${tr}_${tc}`).setMesh(mesh));
    }
  }
}

/** 碰撞用的規則格網（只有頂點），map-build 會轉成高度場。 */
export function addHeightfieldNode(doc: Document, parent: Node, t: TerrainSamples): void {
  const buffer = doc.getRoot().listBuffers()[0]!;
  const cell = t.size / (t.res - 1);
  const positions = new Float32Array(t.res * t.res * 3);
  for (let r = 0; r < t.res; r++) {
    for (let c = 0; c < t.res; c++) {
      positions.set([-t.size / 2 + c * cell, t.heights[r * t.res + c]!, -t.size / 2 + r * cell], (r * t.res + c) * 3);
    }
  }
  const prim = doc.createPrimitive().setMode(0).setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer));
  parent.addChild(
    doc
      .createNode('COL_Terrain')
      .setMesh(doc.createMesh('COL_Terrain').addPrimitive(prim))
      .setExtras({ collider: 'heightfield', grid_rows: t.res, grid_cols: t.res, material: 'dirt' }),
  );
}

// ---- 底色貼圖 ----

type RGB = [number, number, number];

/** 線性色彩（與 Blender 材質的數值同一個空間）。 */
const PALETTE = {
  soil: [0.075, 0.058, 0.04],
  meadow: [0.062, 0.088, 0.03],
  needle: [0.06, 0.043, 0.027],
  leaf: [0.085, 0.058, 0.032],
  moss: [0.035, 0.062, 0.018],
  rock: [0.1, 0.095, 0.085],
  scree: [0.12, 0.112, 0.1],
  riverbed: [0.045, 0.042, 0.034],
  road: [0.13, 0.105, 0.075],
  trail: [0.1, 0.08, 0.055],
  trench: [0.05, 0.04, 0.028],
  pad: [0.11, 0.095, 0.07],
} satisfies Record<string, RGB>;

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0) * (1 - sx) + hash2(x0 + 1, y0) * sx;
  const b = hash2(x0, y0 + 1) * (1 - sx) + hash2(x0 + 1, y0 + 1) * sx;
  return a * (1 - sy) + b * sy;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const toSrgb = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
};

/** 在像素格上以線段距離畫出道路、步道與壕溝的覆蓋率（0–1，邊緣漸淡）。 */
function strokeCoverage(px: number, size: number, lines: Array<{ points: V2[]; halfWidth: number; feather: number }>): Float32Array {
  const out = new Float32Array(px * px);
  const toPx = (v: number) => ((v + size / 2) / size) * (px - 1);
  const cell = size / (px - 1);
  for (const line of lines) {
    const reach = line.halfWidth + line.feather;
    for (let i = 0; i + 1 < line.points.length; i++) {
      const [ax, ay] = line.points[i]!;
      const [bx, by] = line.points[i + 1]!;
      const minC = Math.max(0, Math.floor(toPx(Math.min(ax, bx) - reach)));
      const maxC = Math.min(px - 1, Math.ceil(toPx(Math.max(ax, bx) + reach)));
      // 列 0 在北邊（y = +size/2）
      const minR = Math.max(0, Math.floor(((size / 2 - Math.max(ay, by) - reach) / size) * (px - 1)));
      const maxR = Math.min(px - 1, Math.ceil(((size / 2 - Math.min(ay, by) + reach) / size) * (px - 1)));
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      for (let r = minR; r <= maxR; r++) {
        const y = size / 2 - r * cell;
        for (let c = minC; c <= maxC; c++) {
          const x = -size / 2 + c * cell;
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
          const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
          const cover = 1 - smoothstep(line.halfWidth - line.feather * 0.3, line.halfWidth + line.feather, d);
          if (cover > out[r * px + c]!) {
            out[r * px + c] = cover;
          }
        }
      }
    }
  }
  return out;
}

/** 道路、步道、壕溝與營地整地範圍的覆蓋率（0–1），底色貼圖與草地密度共用。 */
interface GroundCovers {
  road: Float32Array;
  trail: Float32Array;
  trench: Float32Array;
  pad(x: number, y: number): number;
}

function groundCovers(src: ForestSources, layout: Layout, px: number): GroundCovers {
  const roads = Object.values(layout.roads).map((road) => ({
    points: road.polyline_xyz_m.map(([x, y]) => [x, y] as V2),
    halfWidth: road.half_width_m,
    feather: road.kind === 'road' ? 1.2 : 0.8,
    kind: road.kind,
  }));
  const pads = Object.values(layout.sites).filter((s) => /^(HQ_|Lumber|Farmhouse|Bunker)/.test(s.name));
  return {
    road: strokeCoverage(px, src.size, roads.filter((r) => r.kind === 'road')),
    trail: strokeCoverage(px, src.size, roads.filter((r) => r.kind !== 'road')),
    trench: strokeCoverage(px, src.size, [{ points: layout.trench.polyline_xy_m, halfWidth: 1.1, feather: 0.6 }]),
    pad: (x, y) => {
      let cover = 0;
      for (const pad of pads) {
        cover = Math.max(cover, 1 - smoothstep(pad.radius * 0.55, pad.radius * 0.95, Math.hypot(x - pad.x, y - pad.y)));
      }
      return cover;
    },
  };
}

/** 依植被密度、坡度、水域、道路與營地畫出整張地圖的底色（sRGB JPEG）。 */
export async function terrainAlbedo(src: ForestSources, layout: Layout, px = 2048): Promise<Buffer> {
  const size = src.size;
  const covers = groundCovers(src, layout, px);
  const rgb = Buffer.alloc(px * px * 3);
  const cell = size / (px - 1);
  for (let r = 0; r < px; r++) {
    const y = size / 2 - r * cell;
    for (let c = 0; c < px; c++) {
      const x = -size / 2 + c * cell;
      const d = src.density;
      const wGrass = d.grass.sample(x, y) * 1.2;
      const wNeedle = d.needle.sample(x, y);
      const wLeaf = d.leaf.sample(x, y);
      const wMoss = d.moss.sample(x, y) * 0.7;
      const wSoil = 0.18;
      const total = wGrass + wNeedle + wLeaf + wMoss + wSoil;
      let color: RGB = [0, 0, 0];
      for (const [w, col] of [
        [wGrass, PALETTE.meadow],
        [wNeedle, PALETTE.needle],
        [wLeaf, PALETTE.leaf],
        [wMoss, PALETTE.moss],
        [wSoil, PALETTE.soil],
      ] as const) {
        color = [color[0] + col[0] * (w / total), color[1] + col[1] * (w / total), color[2] + col[2] * (w / total)];
      }
      const slope = src.graded.slopeDegrees(x, y);
      color = mix(color, PALETTE.rock, smoothstep(36, 52, slope) * 0.9);
      color = mix(color, PALETTE.scree, Math.min(1, d.scree.sample(x, y) * 1.4));
      color = mix(color, PALETTE.pad, covers.pad(x, y) * 0.8);
      const i = r * px + c;
      color = mix(color, PALETTE.trail, covers.trail[i]!);
      color = mix(color, PALETTE.road, covers.road[i]!);
      color = mix(color, PALETTE.trench, covers.trench[i]!);
      color = mix(color, PALETTE.riverbed, Math.min(1, src.waterMask.sample(x, y) * 1.5));
      // 兩種尺度的雜訊讓大片顏色不會太平均
      const n = 0.82 + 0.22 * valueNoise(x / 9, y / 9) + 0.14 * valueNoise(x / 2.2, y / 2.2);
      rgb[i * 3] = toSrgb(color[0] * n);
      rgb[i * 3 + 1] = toSrgb(color[1] * n);
      rgb[i * 3 + 2] = toSrgb(color[2] * n);
    }
  }
  return sharp(rgb, { raw: { width: px, height: px, channels: 3 } }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

/**
 * 草地密度圖（前端 GPU 草地系統使用，PNG RGB）：R = 草、G = 花。
 * 以 Blender 的草與花密度為基礎，扣掉道路、步道、壕溝、營地、水域與陡坡
 * （Blender 的草實例是在第 5 階段整地前擺放的，這裡補上同樣的清理）。
 * 列 0 在北邊（−Z），欄 0 在西邊（−X）。
 */
export async function grassDensityMap(src: ForestSources, layout: Layout, px = 512): Promise<Buffer> {
  const size = src.size;
  const covers = groundCovers(src, layout, px);
  const rgb = Buffer.alloc(px * px * 3);
  const cell = size / (px - 1);
  for (let r = 0; r < px; r++) {
    const y = size / 2 - r * cell;
    for (let c = 0; c < px; c++) {
      const x = -size / 2 + c * cell;
      const i = r * px + c;
      const keep =
        (1 - covers.road[i]!) *
        (1 - covers.trail[i]! * 0.85) *
        (1 - covers.trench[i]!) *
        (1 - covers.pad(x, y) * 0.9) *
        (1 - Math.min(1, src.waterMask.sample(x, y) * 2.5)) *
        (1 - smoothstep(30, 42, src.graded.slopeDegrees(x, y))) *
        (1 - Math.min(1, src.density.scree.sample(x, y) * 1.5));
      rgb[i * 3] = Math.round(Math.min(1, src.density.grass.sample(x, y)) * keep * 255);
      rgb[i * 3 + 1] = Math.round(Math.min(1, src.density.flowers.sample(x, y)) * keep * 255);
    }
  }
  return sharp(rgb, { raw: { width: px, height: px, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}
