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
  /** 河岸林：潮濕的深色泥土 */
  damp: [0.045, 0.04, 0.026],
  /** 枯木林：焦黑、乾枯的地面 */
  burnt: [0.05, 0.045, 0.038],
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
      // 林區：河岸林的地面較潮濕、枯木林有燒焦與乾枯的痕跡（草地上減弱）
      const open = 1 - Math.min(1, wGrass);
      color = mix(color, PALETTE.damp, (src.zones.riparian?.sample(x, y) ?? 0) * 0.45 * open);
      color = mix(color, PALETTE.burnt, (src.zones.deadwood?.sample(x, y) ?? 0) * (0.35 + 0.3 * valueNoise(x / 5, y / 5)) * open);
      const slope = src.graded.slopeDegrees(x, y);
      // 陡坡露出岩石；山坡上的樹林底下是林地，不畫成岩壁
      color = mix(color, PALETTE.rock, smoothstep(36, 52, slope) * 0.9 * (1 - 0.75 * Math.min(1, d.canopy.sample(x, y) * 1.6)));
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

// ---- 地形起伏與細節圖層 ----

/** 0–1 的分形值雜訊（幾個八度的 valueNoise） */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y) * amp;
    norm += amp;
    x = x * 2.03 + 17.1;
    y = y * 2.03 - 9.4;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * 地形起伏：Blender 的高度圖很平滑（看起來像塑膠），在這裡加上
 * - 地表小起伏：約 3 m、9 m 兩種尺度的土丘與凹陷（±0.2 m 左右）；
 * - 山坡岩層：陡坡上把高度往 3.5 m 一階的層狀拉，加上沿坡的溝槽雜訊，形成岩層與小崖；
 * 道路、營地、壕溝、橋與水域附近不加（建築、水面與道路都依原本的高度擺放）。
 * 直接改 src.graded：植被與岩石實例的高度 = Blender 高度 + (graded − carved)，所以會一起貼地。
 */
export function applyRelief(src: ForestSources, flat: (x: number, y: number) => number): void {
  const g = src.graded;
  const before = Float32Array.from(g.data);
  const at = (r: number, c: number) => before[Math.min(g.res - 1, Math.max(0, r)) * g.res + Math.min(g.res - 1, Math.max(0, c))]!;
  for (let r = 0; r < g.res; r++) {
    const y = g.half - r * g.cell;
    for (let c = 0; c < g.res; c++) {
      const x = -g.half + c * g.cell;
      const keep = 1 - flat(x, y);
      if (keep <= 0) continue;
      // 坡度（以原本的高度計算）
      const dx = (at(r, c + 2) - at(r, c - 2)) / (4 * g.cell);
      const dy = (at(r - 2, c) - at(r + 2, c)) / (4 * g.cell);
      const slope = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
      const h = before[r * g.res + c]!;
      // 地表小起伏：平地明顯、陡坡上交給岩層
      const bumps = (fbm(x / 3.2, y / 3.2, 2) - 0.5) * 0.28 + (fbm(x / 9 + 40, y / 9 - 13, 3) - 0.5) * 0.45;
      let delta = bumps * (1 - 0.6 * smoothstep(25, 40, slope));
      // 岩層：陡坡上把高度往層狀拉（層高 2.5–6 m 隨位置變化、層面傾斜起伏），
      // 強度也隨位置變化（有的地方是明顯的岩階，有的只是粗糙的坡），再加上沿坡的溝槽與碎塊
      const rock = smoothstep(26, 40, slope);
      if (rock > 0) {
        const step = 2.5 + 3.5 * fbm(x / 70 + 11, y / 70 - 5, 2);
        const strataNoise = (fbm(x / 25, y / 25, 3) - 0.5) * step * 1.6;
        const t = (h + strataNoise) / step;
        const f = t - Math.floor(t);
        const terraced = (Math.floor(t) + smoothstep(0.4, 1, f)) * step - strataNoise;
        const strength = 0.08 + 0.32 * smoothstep(0.35, 0.75, fbm(x / 45 - 30, y / 45 + 60, 2));
        const gully = (fbm(x / 7 + 300, y / 7 - 200, 3) - 0.5) * 2.2 + (fbm(x / 2.2, y / 2.2 + 90, 2) - 0.5) * 0.6;
        delta += rock * ((terraced - h) * strength + gully);
      }
      g.data[r * g.res + c] = h + delta * keep;
    }
  }
}

/** 道路的覆蓋率與橫向座標（−1 = 左路肩、0 = 路中央、1 = 右路肩），用來畫車轍。 */
function roadField(px: number, size: number, lines: Array<{ points: V2[]; halfWidth: number }>): { cover: Float32Array; across: Float32Array } {
  const cover = new Float32Array(px * px);
  const across = new Float32Array(px * px);
  const dist = new Float32Array(px * px).fill(Infinity);
  const cell = size / (px - 1);
  const toPx = (v: number) => ((v + size / 2) / size) * (px - 1);
  for (const line of lines) {
    const reach = line.halfWidth + 1.5;
    for (let i = 0; i + 1 < line.points.length; i++) {
      const [ax, ay] = line.points[i]!;
      const [bx, by] = line.points[i + 1]!;
      const minC = Math.max(0, Math.floor(toPx(Math.min(ax, bx) - reach)));
      const maxC = Math.min(px - 1, Math.ceil(toPx(Math.max(ax, bx) + reach)));
      const minR = Math.max(0, Math.floor(((size / 2 - Math.max(ay, by) - reach) / size) * (px - 1)));
      const maxR = Math.min(px - 1, Math.ceil(((size / 2 - Math.min(ay, by) + reach) / size) * (px - 1)));
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      for (let r = minR; r <= maxR; r++) {
        const y = size / 2 - r * cell;
        for (let c = minC; c <= maxC; c++) {
          const x = -size / 2 + c * cell;
          const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (len * len)));
          const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
          const i2 = r * px + c;
          if (d / line.halfWidth < dist[i2]!) {
            dist[i2] = d / line.halfWidth;
            // 有號距離：在線段的左側為負
            const side = Math.sign(dx * (y - ay) - dy * (x - ax)) || 1;
            across[i2] = Math.max(-1, Math.min(1, (side * d) / line.halfWidth));
            cover[i2] = 1 - smoothstep(0.75, 1.25, d / line.halfWidth);
          }
        }
      }
    }
  }
  return { cover, across };
}

/**
 * 地形細節圖層（前端地形 shader 使用，三張 PNG，第 0 列在北邊；不用 alpha 通道，
 * 有些瀏覽器會把 alpha 為 0 的像素的 RGB 清掉）：
 *   splat  RGB：R = 林地落葉、G = 岩石、B = 泥土路面
 *   splat2 RGB：R = 碎石、G = 河岸泥地、B = 路面積水；草地 = 1 − 其他圖層總和
 *   across 灰階：路面橫向座標（−1 左路肩 … 1 右路肩，×0.5+0.5），畫車轍用
 */
export async function terrainLayers(src: ForestSources, layout: Layout, px = 1024): Promise<{ splat: Buffer; splat2: Buffer; across: Buffer }> {
  const size = src.size;
  const covers = groundCovers(src, layout, px);
  const roadLines = Object.values(layout.roads).map((road) => ({ points: road.polyline_xyz_m.map(([x, y]) => [x, y] as V2), halfWidth: road.half_width_m }));
  const roads = roadField(px, size, roadLines);
  const splat = Buffer.alloc(px * px * 3);
  const splat2 = Buffer.alloc(px * px * 3);
  const across = Buffer.alloc(px * px);
  const cell = size / (px - 1);
  const d = src.density;
  for (let r = 0; r < px; r++) {
    const y = size / 2 - r * cell;
    for (let c = 0; c < px; c++) {
      const x = -size / 2 + c * cell;
      const i = r * px + c;
      const slope = src.graded.slopeDegrees(x, y);
      const canopy = Math.min(1, d.canopy.sample(x, y) * 1.5);
      const litter = Math.min(1, (d.needle.sample(x, y) + d.leaf.sample(x, y)) * 1.3);
      const water = Math.min(1, src.waterMask.sample(x, y) * 1.5);
      // 岩石：陡坡，樹林底下少一點；邊界用雜訊打散
      const n = fbm(x / 7, y / 7, 3);
      let rock = smoothstep(30 - 8 * n, 44 - 8 * n, slope) * (1 - 0.6 * canopy);
      let gravel = Math.min(1, d.scree.sample(x, y) * 1.6) * (0.6 + 0.4 * n);
      const surface = Math.max(roads.cover[i]!, covers.trail[i]! * 0.9, covers.trench[i]!, covers.pad(x, y) * 0.75);
      let roadW = surface * (0.75 + 0.25 * fbm(x / 3, y / 3, 2));
      let forest = smoothstep(0.1, 0.7, litter * (0.7 + 0.6 * fbm(x / 4 + 9, y / 4, 2)));
      // 河岸泥地：水邊 2–4 m、河岸林裡多一點
      const bank = Math.max(water, (src.zones.riparian?.sample(x, y) ?? 0) * 0.35 * fbm(x / 5, y / 5 + 7, 2));
      let mud = Math.min(1, bank * 1.2) * (1 - smoothstep(20, 34, slope));
      // 依優先順序分配（路面最優先），避免總和超過 1
      let left = 1;
      const take = (w: number) => {
        const v = Math.min(w, left);
        left -= v;
        return v;
      };
      roadW = take(roadW);
      rock = take(rock);
      gravel = take(gravel);
      mud = take(mud);
      forest = take(forest);
      splat[i * 3] = Math.round(forest * 255);
      splat[i * 3 + 1] = Math.round(rock * 255);
      splat[i * 3 + 2] = Math.round(roadW * 255);
      // 積水：路中央、平坦處、不規則的水窪
      const puddle =
        roads.cover[i]! > 0.5 && slope < 6 ? smoothstep(0.66, 0.74, fbm(x / 2.5 + 50, y / 2.5 - 30, 3)) * (1 - smoothstep(0.5, 0.85, Math.abs(roads.across[i]!))) : 0;
      splat2[i * 3] = Math.round(gravel * 255);
      splat2[i * 3 + 1] = Math.round(mud * 255);
      splat2[i * 3 + 2] = Math.round(puddle * 255);
      across[i] = Math.round((roads.across[i]! * 0.5 + 0.5) * 255);
    }
  }
  return {
    splat: await sharp(splat, { raw: { width: px, height: px, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer(),
    splat2: await sharp(splat2, { raw: { width: px, height: px, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer(),
    across: await sharp(across, { raw: { width: px, height: px, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer(),
  };
}

// ---- 小地圖（俯視衛星圖）----

export interface MinimapTree {
  /** warfront 座標（公尺） */
  x: number;
  z: number;
  /** 樹冠半徑（公尺） */
  radius: number;
  /** 樹冠顏色（sRGB 0–1） */
  color: RGB;
}

/**
 * 俯視衛星圖（sRGB JPEG，第 0 列在北邊）：地形底色 × 山影（西北方光源），
 * 水域依水深上色，每棵樹畫成有受光面與陰影的樹冠。
 */
export async function minimapImage(src: ForestSources, t: TerrainSamples, albedoJpeg: Buffer, trees: MinimapTree[], px = 1024): Promise<Buffer> {
  const { data } = await sharp(albedoJpeg).resize(px, px).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = new Float32Array(px * px * 3);
  const size = src.size;
  const cell = size / px;
  const lx = -0.6;
  const lz = -0.6;
  const ly = 0.53;
  for (let r = 0; r < px; r++) {
    const z = -size / 2 + (r + 0.5) * cell;
    for (let c = 0; c < px; c++) {
      const x = -size / 2 + (c + 0.5) * cell;
      const i = r * px + c;
      const dx = (terrainHeightAt(t, x + cell, z) - terrainHeightAt(t, x - cell, z)) / (2 * cell);
      const dz = (terrainHeightAt(t, x, z + cell) - terrainHeightAt(t, x, z - cell)) / (2 * cell);
      const len = Math.hypot(dx, 1, dz);
      const lambert = Math.max(0, (-dx * lx + ly - dz * lz) / len);
      const shade = 0.45 + 0.85 * lambert;
      let rgb: RGB = [(data[i * 3]! / 255) * shade, (data[i * 3 + 1]! / 255) * shade, (data[i * 3 + 2]! / 255) * shade];
      // 水域：Blender 座標 y = −z
      const depth = src.waterDepth.sample(x, -z);
      const wet = Math.min(1, src.waterMask.sample(x, -z) * 1.5);
      if (wet > 0) {
        const k = Math.min(1, depth / 2.5);
        rgb = mix(rgb, mix([0.22, 0.36, 0.34], [0.05, 0.16, 0.2], k), wet * 0.92);
      }
      img.set(rgb, i * 3);
    }
  }
  // 樹冠：陰影（往東南偏移）→ 樹冠（中央亮、邊緣暗，受光面偏西北）
  const paint = (tree: MinimapTree, shadow: boolean) => {
    const ox = shadow ? tree.radius * 0.45 : 0;
    const cx = (tree.x + size / 2 + ox) / cell;
    const cz = (tree.z + size / 2 + ox) / cell;
    const rp = Math.max(0.8, tree.radius / cell);
    for (let r = Math.max(0, Math.floor(cz - rp)); r <= Math.min(px - 1, Math.ceil(cz + rp)); r++) {
      for (let c = Math.max(0, Math.floor(cx - rp)); c <= Math.min(px - 1, Math.ceil(cx + rp)); c++) {
        const ux = (c + 0.5 - cx) / rp;
        const uz = (r + 0.5 - cz) / rp;
        const d = Math.hypot(ux, uz);
        if (d > 1) continue;
        const i = (r * px + c) * 3;
        const a = Math.min(1, (1 - d) * 3);
        if (shadow) {
          for (let k = 0; k < 3; k++) img[i + k]! *= 1 - 0.45 * a;
        } else {
          const light = 0.7 + 0.5 * Math.max(0, -(ux + uz) * 0.7) - 0.25 * d * d + 0.12 * (hash2(c * 7, r * 13) - 0.5);
          for (let k = 0; k < 3; k++) img[i + k] = img[i + k]! * (1 - a * 0.92) + tree.color[k]! * light * a * 0.92;
        }
      }
    }
  };
  for (const tree of trees) paint(tree, true);
  for (const tree of trees) paint(tree, false);
  const out = Buffer.alloc(px * px * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, img[i]!)) * 255);
  return sharp(out, { raw: { width: px, height: px, channels: 3 } }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
}
