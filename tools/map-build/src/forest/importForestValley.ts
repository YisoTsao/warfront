/**
 * 把 blender-mcp-asset-generator 的輸出（phase1–5）組成一個符合 warfront 匯入慣例的 GLB：
 *
 *   ENV_Terrain        整地後的地形（16 個分塊，底色貼圖由植被密度、坡度、道路、水域畫成）
 *   ENV_Trees / ENV_Foliage / ENV_Rocks
 *                      依實例清單擺放的植被與岩石（共用網格，map-build 會合併成 GPU instancing）
 *   ENV_Buildings      structures.glb 的建築與工事
 *   ENV_Props          水面與瀑布
 *   COLLISION_Static   地形高度場、建築碰撞方塊、樹幹、岩石、地圖邊界
 *   GAMEPLAY_*         兩隊出生點（HQ）、四個征服據點、敵方基地禁區、水域
 *   LIGHTING_Reference 太陽（Blender 燈光預設 noon）
 *
 * Blender 端的程序化材質無法匯出（GLB 裡都是白色），這裡依原始材質腳本的顏色重新指定；
 * 樹皮已改用 Poly Haven 的 CC0 掃描貼圖（Blender 端 assets/textures/bark），有貼圖時保留貼圖、底色設為白色。
 * 樹種與林區（河岸林、闊葉林、混交林、松林、雲杉林、枯木林）由 phase3 決定；林區圖也用來畫地形底色。
 * 草與花（約 22 萬個實例）不匯入成網格，改輸出密度圖（scene extras.frontline_grass），由前端的 GPU 草地系統產生。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Document, NodeIO, type Material, type Mesh, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { copyToDocument, unpartition } from '@gltf-transform/functions';
import sharp from 'sharp';
import { buildLods, triangleCount, type LodPlan } from './lod';
import { Grid, readForestSources, toWorld, type ForestSources, type InstanceSet, type Layout, type V2, type V3 } from './sources';
import {
  addHeightfieldNode,
  addTerrainTiles,
  applyRelief,
  grassDensityMap,
  minimapImage,
  type MinimapTree,
  terrainAlbedo,
  terrainHeightAt,
  terrainLayers,
  terrainSamples,
  type TerrainSamples,
} from './terrain';

/** 小地圖上的樹冠：半徑（公尺，再乘實例縮放）與顏色（sRGB） */
const MINIMAP_CROWNS: Record<string, { radius: number; color: [number, number, number] }> = {
  pine: { radius: 2.6, color: [0.16, 0.24, 0.14] },
  spruce: { radius: 2.4, color: [0.1, 0.18, 0.13] },
  oak: { radius: 5.0, color: [0.24, 0.32, 0.13] },
  maple: { radius: 4.4, color: [0.28, 0.35, 0.12] },
  alder: { radius: 2.8, color: [0.18, 0.27, 0.12] },
  birch: { radius: 2.4, color: [0.34, 0.41, 0.17] },
  dead: { radius: 1.0, color: [0.32, 0.29, 0.24] },
  bush: { radius: 0.9, color: [0.2, 0.28, 0.11] },
};

/** 地形細節貼圖（Poly Haven CC0，見 assets/textures/terrain/SOURCE.md）；順序即前端 shader 的圖層索引 */
const TERRAIN_TEXTURE_DIR = resolve(import.meta.dirname, '../../../../assets/textures/terrain');
const TERRAIN_DETAIL = [
  { name: 'grass', file: 'leafy_grass', tile: 2.0 },
  { name: 'forest', file: 'forest_floor', tile: 2.14 },
  { name: 'rock', file: 'rock_face_04', tile: 4.0 },
  { name: 'road', file: 'stony_dirt_path', tile: 2.17 },
  { name: 'gravel', file: 'rocky_gravel', tile: 1.81 },
  { name: 'mud', file: 'mud_forest', tile: 2.35 },
] as const;

type Quat = [number, number, number, number];

export interface ForestImportOptions {
  /** blender-mcp-asset-generator 的 output 目錄 */
  source: string;
  /** 寫出的 GLB 路徑 */
  output: string;
  log?: (message: string) => void;
}

export interface ForestImportReport {
  output: string;
  instances: Record<string, { kept: number; removed: number }>;
  colliders: number;
  spawns: number;
  objectives: number;
  waterVolumes: number;
  lodTriangles: Record<string, [number, number]>;
  warnings: string[];
}

// ---- 四元數 ----

const qMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxis = (axis: V3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
const qYaw = (angle: number): Quat => qAxis([0, 1, 0], angle);
const qRotate = (q: Quat, v: V3): V3 => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** 把單位向量 a 轉到 b 的四元數 */
const qFromTo = (a: V3, b: V3): Quat => {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.999999) {
    const axis: V3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [a[2], 0, -a[0]];
    const len = Math.hypot(...axis);
    return [axis[0] / len, axis[1] / len, axis[2] / len, 0];
  }
  const c: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const q: Quat = [c[0], c[1], c[2], 1 + dot];
  const len = Math.hypot(...q);
  return q.map((v) => v / len) as Quat;
};
/** Blender 的 XYZ 尤拉角（度，Z 朝上）→ warfront（Y 朝上）的四元數 */
const blenderEulerToQuat = (rx: number, ry: number, rz: number): Quat => {
  const d = Math.PI / 180;
  const qb = qMul(qMul(qAxis([0, 0, 1], rz * d), qAxis([0, 1, 0], ry * d)), qAxis([1, 0, 0], rx * d));
  return [qb[0], qb[2], -qb[1], qb[3]];
};

const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

// ---- 材質：Blender 程序化材質的代表色（線性） ----

const MATERIAL_COLORS: Record<string, { color: [number, number, number]; roughness?: number; metallic?: number }> = {
  M_Bark_pine: { color: [0.085, 0.05, 0.03] },
  M_Bark_spruce: { color: [0.07, 0.055, 0.042] },
  M_Bark_oak: { color: [0.05, 0.042, 0.032] },
  M_Bark_maple: { color: [0.07, 0.062, 0.05] },
  M_Bark_alder: { color: [0.1, 0.095, 0.085] },
  M_Bark_birch: { color: [0.52, 0.5, 0.46] },
  M_Bark_dead: { color: [0.24, 0.22, 0.2] },
  M_Bark_log_moss: { color: [0.08, 0.075, 0.045] },
  M_Rock: { color: [0.1, 0.094, 0.083], roughness: 0.92 },
  M_Rock_Strata: { color: [0.105, 0.094, 0.08], roughness: 0.92 },
  M_Rock_River: { color: [0.09, 0.085, 0.072], roughness: 0.75 },
  M_Wood_Planks: { color: [0.12, 0.085, 0.055] },
  M_Wood_Dark: { color: [0.06, 0.044, 0.03] },
  M_Wood_Old: { color: [0.095, 0.085, 0.07] },
  M_Wood_Crate: { color: [0.085, 0.09, 0.05] },
  M_Log_Peeled: { color: [0.11, 0.078, 0.048] },
  M_Stone_Abutment: { color: [0.09, 0.085, 0.075] },
  M_Stone_Farmhouse: { color: [0.12, 0.1, 0.08] },
  M_Stone_Ruin: { color: [0.085, 0.083, 0.075] },
  M_Plaster_Old: { color: [0.3, 0.28, 0.25] },
  M_Concrete: { color: [0.22, 0.215, 0.2] },
  M_Sandbag: { color: [0.13, 0.11, 0.072] },
  M_Canvas_Olive: { color: [0.065, 0.07, 0.035] },
  M_HESCO: { color: [0.25, 0.22, 0.16] },
  M_Metal_Corrugated_Rust: { color: [0.18, 0.08, 0.03], roughness: 0.8, metallic: 0.3 },
  M_Metal_Olive: { color: [0.06, 0.07, 0.035], roughness: 0.7, metallic: 0.4 },
  M_Roof_Slate: { color: [0.055, 0.058, 0.062] },
  M_Water: { color: [0.025, 0.07, 0.065], roughness: 0.06 },
  M_Waterfall: { color: [0.8, 0.86, 0.88], roughness: 0.35 },
};

function fixMaterial(material: Material): void {
  const spec = MATERIAL_COLORS[material.getName()];
  if (material.getName().startsWith('M_Foliage_')) {
    // 葉片卡：用 alpha 測試取代混合，避免數千張卡片排序問題，也能投射陰影
    material.setAlphaMode('MASK').setAlphaCutoff(0.45).setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(0.75);
    material.setExtras({ frontline_foliage: true });
    return;
  }
  if (material.getName() === 'M_Water') {
    // Blender 的水面材質用高度圖做岸邊漸淡，網頁版不需要；前端以 frontline_shader 換成水面 shader
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null);
    material.setBaseColorFactor([...spec!.color, 0.78]).setAlphaMode('BLEND').setRoughnessFactor(0.06).setMetallicFactor(0);
    material.setExtras({ frontline_shader: 'water' });
    return;
  }
  if (material.getName() === 'M_Waterfall') {
    material.setBaseColorFactor([...spec!.color, 0.55]).setAlphaMode('BLEND').setDoubleSided(true).setMetallicFactor(0);
    material.setExtras({ frontline_shader: 'waterfall' });
    return;
  }
  if (spec && material.getName().startsWith('M_Bark_') && material.getBaseColorTexture()) {
    // 掃描貼圖本身就是顏色；稍微壓暗，和其他以線性代表色指定的材質亮度一致
    material.setBaseColorFactor([0.8, 0.8, 0.8, 1]).setRoughnessFactor(0.92).setMetallicFactor(0);
    material.setNormalTexture(null).setMetallicRoughnessTexture(null);
  } else if (spec) {
    material.setBaseColorFactor([...spec.color, 1]).setRoughnessFactor(spec.roughness ?? 0.9).setMetallicFactor(spec.metallic ?? 0);
  }
  if (material.getAlphaMode() === 'BLEND' && !material.getBaseColorTexture()) {
    material.setAlphaMode('OPAQUE');
  }
}

// ---- 實例分類與 LOD ----

interface AssetClass {
  role: 'ENV_Trees' | 'ENV_Foliage' | 'ENV_Rocks';
  lod: LodPlan;
  /** 大型物件：離道路與營地要更遠（與 phase5 的清理規則一致） */
  big: boolean;
  collider?: 'trunk' | 'bounds';
  /** bounds 碰撞的縮放（岩石埋在地裡、外形不規則，用較小的方塊避免隱形牆） */
  boundsScale?: number;
  material?: string;
  /** 超過這個距離不畫（公尺）；小物件用 */
  cull?: number;
}

/** 樹的遠景 LOD2（130 m 以外）：樹幹剩 5%、葉片卡剩 8% 並放大 1.9 倍，遠看只需要樹冠的剪影 */
const TREE_LOD2 = { solid: 0.05, cards: 0.08, grow: 1.9 };

const VEGETATION: Record<string, AssetClass> = {
  pine: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.25, lod1Cards: 0.3, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  spruce: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.25, lod1Cards: 0.22, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  oak: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.25, lod1Cards: 0.3, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  maple: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.25, lod1Cards: 0.3, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  alder: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.3, lod1Cards: 0.35, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  birch: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.3, lod1Cards: 0.35, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  dead: { role: 'ENV_Trees', lod: { lod0Solid: 1, lod1Solid: 0.3, lod1Cards: 0.4, lod2: TREE_LOD2 }, big: true, collider: 'trunk', material: 'wood' },
  log: { role: 'ENV_Foliage', lod: { lod0Solid: 1, lod1Solid: 0.3, lod1Cards: 1 }, big: true, collider: 'bounds', boundsScale: 0.85, material: 'wood' },
  bush: { role: 'ENV_Foliage', lod: { lod0Solid: 1, lod1Solid: 0.4, lod1Cards: 0.4 }, big: true, cull: 150 },
  fern: { role: 'ENV_Foliage', lod: { lod0Solid: 1, lod1Solid: 1, lod1Cards: 0.5 }, big: false, cull: 70 },
};

const ROCKS: Record<string, AssetClass> = {
  cliff: { role: 'ENV_Rocks', lod: { lod0Solid: 0.3, lod1Solid: 0.06, lod1Cards: 1 }, big: true, collider: 'bounds', boundsScale: 0.62, material: 'rock' },
  mountain: { role: 'ENV_Rocks', lod: { lod0Solid: 0.3, lod1Solid: 0.06, lod1Cards: 1 }, big: true, collider: 'bounds', boundsScale: 0.62, material: 'rock' },
  boulder: { role: 'ENV_Rocks', lod: { lod0Solid: 0.3, lod1Solid: 0.06, lod1Cards: 1 }, big: true, collider: 'bounds', boundsScale: 0.72, material: 'rock' },
  weathered: { role: 'ENV_Rocks', lod: { lod0Solid: 0.3, lod1Solid: 0.06, lod1Cards: 1 }, big: true, collider: 'bounds', boundsScale: 0.72, material: 'rock' },
  moss: { role: 'ENV_Rocks', lod: { lod0Solid: 0.3, lod1Solid: 0.06, lod1Cards: 1 }, big: true, collider: 'bounds', boundsScale: 0.72, material: 'rock' },
  river: { role: 'ENV_Rocks', lod: { lod0Solid: 0.5, lod1Solid: 0.12, lod1Cards: 1 }, big: false, collider: 'bounds', boundsScale: 0.75, material: 'rock', cull: 160 },
  pebble: { role: 'ENV_Rocks', lod: { lod0Solid: 1, lod1Solid: 0.25, lod1Cards: 1 }, big: false, cull: 60 },
};

/** 結構的命中材質（特效與腳步聲） */
function structureMaterial(name: string): string {
  if (/Bridge|Lumber|Trench/.test(name)) return 'wood';
  if (/Farmhouse|Ruins/.test(name)) return 'stone';
  if (/Bunker/.test(name)) return 'concrete';
  if (/Hedgehog/.test(name)) return 'metal';
  return 'sand';
}

// ---- 幾何工具 ----

interface Bounds {
  min: V3;
  max: V3;
}

function meshBounds(mesh: Mesh, filter?: (materialName: string) => boolean): Bounds {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const el: number[] = [];
  for (const prim of mesh.listPrimitives()) {
    if (filter && !filter(prim.getMaterial()?.getName() ?? '')) {
      continue;
    }
    const pos = prim.getAttribute('POSITION')!;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, el[k]!);
        max[k] = Math.max(max[k]!, el[k]!);
      }
    }
  }
  return { min, max };
}

/** 樹幹半徑：樹皮頂點在 0.5–1.5 m 高度的水平距離中位數 */
function trunkRadius(mesh: Mesh): number {
  const radii: number[] = [];
  const el: number[] = [];
  for (const prim of mesh.listPrimitives()) {
    if (!(prim.getMaterial()?.getName() ?? '').startsWith('M_Bark')) {
      continue;
    }
    const pos = prim.getAttribute('POSITION')!;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      if (el[1]! > 0.5 && el[1]! < 1.5) {
        radii.push(Math.hypot(el[0]!, el[2]!));
      }
    }
  }
  radii.sort((a, b) => a - b);
  return radii.length > 0 ? radii[Math.floor(radii.length / 2)]! : 0.25;
}

interface BoxSpec {
  center: V3;
  size: V3;
  rotation: Quat;
  material: string;
  layer?: 'movement' | 'bullet' | 'both';
  name: string;
}

function insideBox(box: BoxSpec, p: V3, margin = 0): boolean {
  const local = qRotate(qConj(box.rotation), [p[0] - box.center[0], p[1] - box.center[1], p[2] - box.center[2]]);
  return local.every((v, i) => Math.abs(v) <= box.size[i]! / 2 + margin);
}

/** 由結構網格頂點推算膠囊碰撞的軸向（layout 只記錄中心、半徑與長度）。 */
function capsuleAxis(points: V3[], center: V3, radius: number, length: number): V3 {
  const reach = length / 2 + radius + 0.05;
  const near = points.filter((p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) <= reach);
  if (near.length < 8) {
    return [0, 1, 0];
  }
  const mean: V3 = [0, 0, 0];
  for (const p of near) {
    mean[0] += p[0] / near.length;
    mean[1] += p[1] / near.length;
    mean[2] += p[2] / near.length;
  }
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of near) {
    const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j]! += d[i]! * d[j]!;
  }
  let v: V3 = [0.3, 0.9, 0.3];
  for (let it = 0; it < 40; it++) {
    const n: V3 = [
      cov[0]! * v[0] + cov[1]! * v[1] + cov[2]! * v[2],
      cov[3]! * v[0] + cov[4]! * v[1] + cov[5]! * v[2],
      cov[6]! * v[0] + cov[7]! * v[1] + cov[8]! * v[2],
    ];
    const len = Math.hypot(...n) || 1;
    v = [n[0] / len, n[1] / len, n[2] / len];
  }
  return v;
}

/** 清理規則（重現 phase5 在 Blender 內做的實例清理）：道路、壕溝、橋、營地附近不放植被與岩石。 */
function makeClearance(layout: Layout) {
  const discs: Array<[number, number, number]> = [];
  for (const road of Object.values(layout.roads)) {
    for (const [x, y] of road.polyline_xyz_m) discs.push([x, y, road.half_width_m + 0.8]);
  }
  for (const [x, y] of layout.trench.polyline_xy_m) discs.push([x, y, 1.6]);
  const [a, b] = layout.bridge.abutments_xy_m;
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (let s = -2; s <= span + 2; s += 1) {
    const t = s / span;
    discs.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 3.5]);
  }
  for (const site of Object.values(layout.sites)) {
    if (/^(HQ_|Farmhouse|Ruins|Lumber|Bunker)/.test(site.name)) discs.push([site.x, site.y, site.radius]);
  }
  const camp = layout.sites.Lumber_Camp;
  return {
    blocked(x: number, y: number, big: boolean): boolean {
      const extra = big ? 2.2 : 0;
      return discs.some(([dx, dy, r]) => (x - dx) ** 2 + (y - dy) ** 2 < (r + extra) ** 2);
    },
    /** 伐木場 22 m 內的樹 75% 被砍掉 */
    logged(x: number, y: number, index: number): boolean {
      return camp !== undefined && Math.hypot(x - camp.x, y - camp.y) < 22 && ((index * 2654435761) >>> 0) % 100 < 75;
    },
  };
}

/**
 * 不加地表起伏的範圍（0–1）：道路、步道、壕溝、橋、營地與建築周圍，以及水域附近。
 * 以 1025 高度圖的格子為單位先畫成遮罩，起伏邊界有 3 m 的漸變。
 */
function flatMask(src: ForestSources, layout: Layout): (x: number, y: number) => number {
  const g = src.graded;
  const mask = new Float32Array(g.res * g.res);
  const disc = (cx: number, cy: number, radius: number, feather = 3) => {
    const reach = radius + feather;
    const c0 = Math.max(0, Math.floor((cx - reach + g.half) / g.cell));
    const c1 = Math.min(g.res - 1, Math.ceil((cx + reach + g.half) / g.cell));
    const r0 = Math.max(0, Math.floor((g.half - cy - reach) / g.cell));
    const r1 = Math.min(g.res - 1, Math.ceil((g.half - cy + reach) / g.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(-g.half + c * g.cell - cx, g.half - r * g.cell - cy);
        const v = d <= radius ? 1 : d >= reach ? 0 : 1 - (d - radius) / feather;
        if (v > mask[r * g.res + c]!) mask[r * g.res + c] = v;
      }
    }
  };
  const line = (points: V2[], radius: number) => {
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.8));
      for (let k = 0; k <= n; k++) disc(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, radius);
    }
  };
  for (const road of Object.values(layout.roads)) line(road.polyline_xyz_m.map(([x, y]) => [x, y] as V2), road.half_width_m + 1);
  line(layout.trench.polyline_xy_m, 2.5);
  line(layout.bridge.abutments_xy_m, 6);
  for (const site of Object.values(layout.sites)) disc(site.x, site.y, site.radius + 2);
  for (const structure of layout.structures) {
    const reach = Math.max(2, ...structure.colliders.map((c) => Math.hypot(c.size_m[0] ?? 0, c.size_m[1] ?? 0) / 2 + Math.hypot(c.center_m[0] - structure.location_m[0], c.center_m[1] - structure.location_m[1])));
    disc(structure.location_m[0], structure.location_m[1], reach + 1.5);
  }
  // 水域：水面遮罩往外 3 m（水面網格與岸邊依原本的高度）
  const w = src.waterMask;
  const step = Math.max(1, Math.round(1 / w.cell));
  for (let r = 0; r < w.res; r += step) {
    for (let c = 0; c < w.res; c += step) {
      if (w.at(r, c) > 0.5) disc(-w.half + c * w.cell, w.half - r * w.cell, 1.5, 3);
    }
  }
  const grid = new Grid(mask, g.res, g.size);
  return (x, y) => grid.sample(x, y);
}

/** 水域：把水面遮罩切成 8 m 方塊，每塊一個水體（底部到水面），深度超過 1.3 m 為深水。 */
function waterVolumes(src: ForestSources, block = 8): Array<{ min: V3; max: V3; deep: boolean }> {
  const out: Array<{ min: V3; max: V3; deep: boolean }> = [];
  const mask = src.waterMask;
  const per = Math.max(1, Math.round(block / mask.cell));
  for (let br = 0; br < mask.res; br += per) {
    for (let bc = 0; bc < mask.res; bc += per) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, bed = Infinity, surface = -Infinity, depth = 0;
      for (let r = br; r < Math.min(mask.res, br + per); r++) {
        for (let c = bc; c < Math.min(mask.res, bc + per); c++) {
          if (mask.at(r, c) < 0.5) continue;
          const x = -mask.half + c * mask.cell;
          const y = mask.half - r * mask.cell;
          const d = src.waterDepth.sample(x, y);
          const h = src.carved.sample(x, y);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          bed = Math.min(bed, h);
          if (d > 0.05) surface = Math.max(surface, h + d);
          depth = Math.max(depth, d);
        }
      }
      if (minX === Infinity || surface === -Infinity) continue;
      const half = mask.cell / 2;
      const a = toWorld(minX - half, maxY + half, bed - 0.5);
      const b = toWorld(maxX + half, minY - half, surface + 0.05);
      out.push({ min: [round(a[0]), round(a[1]), round(a[2])], max: [round(b[0]), round(b[1]), round(b[2])], deep: depth > 1.3 });
    }
  }
  return out;
}

export async function importForestValley(options: ForestImportOptions): Promise<ForestImportReport> {
  const log = options.log ?? (() => undefined);
  const warnings: string[] = [];
  log(`讀取 Blender 輸出：${options.source}`);
  const src = await readForestSources(options.source);
  const layout = src.layout;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('ForestValley');
  doc.getRoot().setDefaultScene(scene);
  scene.setExtras({
    frontline_build: { chunk_size: 125, terrain_chunk_size: 125, stream_distance: 330, lod_distances: [55, 130], shared_library: true },
    source: 'blender-mcp-asset-generator phase1–5',
  });
  const collection = (name: string) => {
    const node = doc.createNode(name);
    scene.addChild(node);
    return node;
  };
  const env = {
    terrain: collection('ENV_Terrain'),
    trees: collection('ENV_Trees'),
    foliage: collection('ENV_Foliage'),
    rocks: collection('ENV_Rocks'),
    buildings: collection('ENV_Buildings'),
    props: collection('ENV_Props'),
  };
  const collisionRoot = collection('COLLISION_Static');
  const spawnRoot = collection('GAMEPLAY_SpawnPoints');
  const objectiveRoot = collection('GAMEPLAY_Objectives');
  const restrictedRoot = collection('GAMEPLAY_RestrictedAreas');
  const waterRoot = collection('GAMEPLAY_WaterVolumes');
  const lightingRoot = collection('LIGHTING_Reference');

  // ---- 地形 ----
  log('加上地表起伏與岩層');
  applyRelief(src, flatMask(src, layout));
  log('產生地形分塊、高度場與底色貼圖');
  const terrain: TerrainSamples = terrainSamples(src.graded);
  const albedo = await terrainAlbedo(src, layout);
  const terrainTexture = doc.createTexture('T_Terrain_Albedo').setImage(albedo).setMimeType('image/jpeg');
  const terrainMaterial = doc.createMaterial('M_Terrain').setBaseColorTexture(terrainTexture).setRoughnessFactor(0.95).setMetallicFactor(0);
  addTerrainTiles(doc, env.terrain, terrain, terrainMaterial, 4);
  addHeightfieldNode(doc, collisionRoot, terrain);
  // 地形細節：前端以 frontline_shader = terrain 換成混合六種掃描貼圖的地形 shader
  terrainMaterial.setExtras({ frontline_shader: 'terrain' });
  log('產生地形細節圖層');
  const layers = await terrainLayers(src, layout);
  doc.createTexture('T_Terrain_Splat').setImage(layers.splat).setMimeType('image/png');
  doc.createTexture('T_Terrain_Splat2').setImage(layers.splat2).setMimeType('image/png');
  doc.createTexture('T_Terrain_Across').setImage(layers.across).setMimeType('image/png');
  for (const layer of TERRAIN_DETAIL) {
    for (const kind of ['diff', 'nor_gl'] as const) {
      const image = readFileSync(join(TERRAIN_TEXTURE_DIR, `${layer.file}_${kind}.jpg`));
      doc.createTexture(`T_Detail_${layer.name}_${kind === 'diff' ? 'albedo' : 'normal'}`).setImage(image).setMimeType('image/jpeg');
    }
  }
  scene.setExtras({
    ...scene.getExtras(),
    frontline_terrain: {
      splat_texture: 'T_Terrain_Splat',
      splat2_texture: 'T_Terrain_Splat2',
      across_texture: 'T_Terrain_Across',
      layers: TERRAIN_DETAIL.map((l) => ({ name: l.name, albedo: `T_Detail_${l.name}_albedo`, normal: `T_Detail_${l.name}_normal`, tile: l.tile })),
      origin: [-src.size / 2, -src.size / 2],
      size: src.size,
    },
  });
  const groundAt = (x: number, z: number) => terrainHeightAt(terrain, x, z);

  // ---- 匯入 Blender 資產 ----
  const importMeshes = async (path: string): Promise<Map<string, Mesh>> => {
    const other = await io.read(path);
    const meshes = other.getRoot().listMeshes();
    const map = copyToDocument(doc, other, meshes);
    return new Map(meshes.map((m) => [m.getName(), map.get(m) as Mesh]));
  };
  const importNodes = async (path: string, keep: (name: string) => boolean): Promise<Node[]> => {
    const other = await io.read(path);
    const nodes = other.getRoot().listNodes().filter((n) => n.getMesh() && keep(n.getName()));
    const map = copyToDocument(doc, other, nodes);
    return nodes.map((n) => map.get(n) as Node);
  };

  const vegMeshes = await importMeshes(src.files.vegetation);
  const rockMeshes = await importMeshes(src.files.rocks);
  const structures = await importNodes(src.files.structures, (name) => !/^(Road_|Track_|Trail_)/.test(name));
  const water = await importNodes(src.files.water, () => true);
  for (const material of doc.getRoot().listMaterials()) {
    fixMaterial(material);
  }
  // 葉片貼圖很暗（Blender 靠半透明散射提亮）；網頁版的標準材質沒有這個效果，直接提高亮度
  const brightened = new Set<unknown>();
  for (const material of doc.getRoot().listMaterials()) {
    const texture = material.getName().startsWith('M_Foliage_') ? material.getBaseColorTexture() : null;
    const image = texture?.getImage();
    if (texture && image && !brightened.has(texture)) {
      brightened.add(texture);
      texture.setImage(await sharp(image).modulate({ brightness: 1.9, saturation: 1.05 }).png({ compressionLevel: 9 }).toBuffer()).setMimeType('image/png');
    }
  }
  for (const node of structures) env.buildings.addChild(node);
  for (const node of water) env.props.addChild(node);

  // ---- LOD ----
  const lodTriangles: Record<string, [number, number]> = {};
  const lod0 = new Map<string, Mesh>();
  for (const [kind, sets, meshes] of [
    ['veg', src.vegetation, vegMeshes],
    ['rock', src.rocks, rockMeshes],
  ] as const) {
    const classes = kind === 'veg' ? VEGETATION : ROCKS;
    for (const [setName, set] of Object.entries(sets)) {
      const cls = classes[setName];
      if (!cls) continue;
      for (const asset of set.assets) {
        if (lod0.has(asset)) continue;
        const mesh = meshes.get(asset);
        if (!mesh) {
          warnings.push(`找不到資產網格 ${asset}`);
          continue;
        }
        const original = triangleCount(mesh);
        const result = await buildLods(doc, mesh, cls.lod);
        const lod1 = doc.getRoot().listMeshes().find((m) => m.getName() === `${asset}_LOD1`)!;
        if (cls.cull) result.setExtras({ ...result.getExtras(), cull_distance: cls.cull });
        lod0.set(asset, result);
        lodTriangles[asset] = [triangleCount(result), triangleCount(lod1)];
        if (triangleCount(result) > original) warnings.push(`${asset} 的 LOD0 比原始網格大`);
      }
    }
  }
  // 草與花不匯入成網格（前端依密度圖產生）：刪掉沒有用到的網格
  for (const [name, mesh] of vegMeshes) {
    if (!lod0.has(name)) mesh.dispose();
  }

  // ---- 碰撞方塊 ----
  const unitBox = doc.createMesh('COL_Box').addPrimitive(
    doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setType('VEC3')
          .setBuffer(buffer)
          .setArray(new Float32Array([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5])),
      )
      .setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setBuffer(buffer)
          .setArray(new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])),
      ),
  );
  const boxes: BoxSpec[] = [];
  const addBox = (box: BoxSpec) => {
    boxes.push(box);
    collisionRoot.addChild(
      doc
        .createNode(box.name)
        .setMesh(unitBox)
        .setTranslation(box.center.map((v) => round(v)) as V3)
        .setRotation(box.rotation)
        .setScale(box.size.map((v) => round(Math.max(v, 0.02))) as V3)
        .setExtras({ collider: 'box', material: box.material, ...(box.layer ? { layer: box.layer } : {}) }),
    );
  };

  // 建築：layout 裡的碰撞方塊與膠囊
  const structurePoints = new Map<string, V3[]>();
  for (const node of structures) {
    const mesh = node.getMesh()!;
    const m = node.getWorldMatrix();
    const pts: V3[] = [];
    const el: number[] = [];
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, el);
        pts.push([
          m[0] * el[0]! + m[4] * el[1]! + m[8] * el[2]! + m[12],
          m[1] * el[0]! + m[5] * el[1]! + m[9] * el[2]! + m[13],
          m[2] * el[0]! + m[6] * el[1]! + m[10] * el[2]! + m[14],
        ]);
      }
    }
    structurePoints.set(node.getName(), pts);
  }
  for (const structure of layout.structures) {
    const material = structureMaterial(structure.name);
    structure.colliders.forEach((col, i) => {
      const center = toWorld(...col.center_m);
      const name = `UBX_${structure.name}_${i}`;
      if (col.type === 'box') {
        const [sx, sy, sz] = col.size_m as V3;
        addBox({ name, center, size: [sx, sz, sy], rotation: qYaw((col.yaw_deg * Math.PI) / 180), material });
      } else {
        const [radius, length] = col.size_m as [number, number];
        const axis = capsuleAxis(structurePoints.get(structure.name) ?? [], center, radius, length);
        addBox({ name, center, size: [radius * 1.8, length + radius, radius * 1.8], rotation: qFromTo([0, 1, 0], axis), material });
      }
    });
  }

  // ---- 植被與岩石實例 ----
  const clearance = makeClearance(layout);
  const minimapTrees: MinimapTree[] = [];
  const instances: ForestImportReport['instances'] = {};
  const placeSet = (setName: string, set: InstanceSet, cls: AssetClass) => {
    const parent = cls.role === 'ENV_Trees' ? env.trees : cls.role === 'ENV_Rocks' ? env.rocks : env.foliage;
    let kept = 0;
    let removed = 0;
    set.instances.forEach((row, index) => {
      const [xc, yc, zc, rx, ry, rz, scale, variant] = row as [number, number, number, number, number, number, number, number];
      const x = xc / 100;
      const y = yc / 100;
      const isTree = cls.role === 'ENV_Trees' && setName !== 'dead';
      if (clearance.blocked(x, y, cls.big) || (isTree && clearance.logged(x, y, index))) {
        removed++;
        return;
      }
      const asset = set.assets[Math.round(variant)] ?? set.assets[0]!;
      const mesh = lod0.get(asset);
      if (!mesh) return;
      // phase5 整地後重新貼地：加上整地前後的高度差
      const z = zc / 100 + (src.graded.sample(x, y) - src.carved.sample(x, y));
      const position = toWorld(x, y, z);
      const rotation = blenderEulerToQuat(rx, ry, rz);
      parent.addChild(
        doc
          .createNode(`${asset}_${index}`)
          .setMesh(mesh)
          .setTranslation(position.map((v) => round(v)) as V3)
          .setRotation(rotation.map((v) => round(v, 5)) as Quat)
          .setScale([round(scale), round(scale), round(scale)]),
      );
      kept++;
      const crown = MINIMAP_CROWNS[setName];
      if (crown) minimapTrees.push({ x: position[0], z: position[2], radius: crown.radius * scale, color: crown.color });
      if (cls.collider === 'trunk') {
        const radius = trunkRadius(mesh) * scale * 0.9;
        const b = meshBounds(mesh);
        // 樹幹碰撞只到分枝處：橡樹與楓樹的主幹短、樹冠寬
        const height = (b.max[1] - b.min[1]) * scale * (setName === 'oak' ? 0.35 : setName === 'maple' ? 0.42 : 0.6);
        const yaw = qYaw((rz * Math.PI) / 180);
        addBox({
          name: `UBX_${asset}_${index}`,
          center: [position[0], position[1] + height / 2 - 0.3, position[2]],
          size: [radius * 1.8, height, radius * 1.8],
          rotation: yaw,
          material: cls.material ?? 'wood',
        });
      } else if (cls.collider === 'bounds') {
        const b = meshBounds(mesh, (name) => !name.startsWith('M_Foliage'));
        const local: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
        const offset = qRotate(rotation, [local[0] * scale, local[1] * scale, local[2] * scale]);
        const k = (cls.boundsScale ?? 0.8) * scale;
        const size: V3 = [(b.max[0] - b.min[0]) * k, (b.max[1] - b.min[1]) * k, (b.max[2] - b.min[2]) * k];
        if (Math.max(...size) < 0.5) return;
        addBox({
          name: `UBX_${asset}_${index}`,
          center: [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]],
          size,
          rotation,
          material: cls.material ?? 'rock',
        });
      }
    });
    instances[setName] = { kept, removed };
  };
  for (const [name, set] of Object.entries(src.vegetation)) {
    const cls = VEGETATION[name];
    if (cls) placeSet(name, set, cls);
    else instances[name] = { kept: 0, removed: set.instances.length };
  }
  for (const [name, set] of Object.entries(src.rocks)) {
    const cls = ROCKS[name];
    if (cls) placeSet(`rock_${name}`, set, cls);
  }

  // ---- 地圖邊界（只擋人） ----
  const half = src.size / 2;
  for (const [name, center, size] of [
    ['UBX_Boundary_N', [0, 60, -half - 0.5], [src.size + 2, 200, 1]],
    ['UBX_Boundary_S', [0, 60, half + 0.5], [src.size + 2, 200, 1]],
    ['UBX_Boundary_W', [-half - 0.5, 60, 0], [1, 200, src.size + 2]],
    ['UBX_Boundary_E', [half + 0.5, 60, 0], [1, 200, src.size + 2]],
  ] as Array<[string, V3, V3]>) {
    addBox({ name, center, size, rotation: [0, 0, 0, 1], material: 'rock', layer: 'movement' });
  }

  // ---- 遊戲標記 ----
  const sites = layout.sites;
  const centre: V2 = [
    Object.values(sites).reduce((s, v) => s + v.x, 0) / Object.keys(sites).length,
    Object.values(sites).reduce((s, v) => s + v.y, 0) / Object.keys(sites).length,
  ];
  let spawns = 0;
  for (const [team, hq] of [
    ['alpha', 'HQ_South'],
    ['bravo', 'HQ_North'],
  ] as const) {
    (layout.hq_spawn_hints_m[hq] ?? []).forEach(([x, y], i) => {
      const [wx, , wz] = toWorld(x, y, 0);
      const feet: V3 = [round(wx), round(groundAt(wx, wz) + 0.05), round(wz)];
      if (boxes.some((b) => b.layer !== 'movement' && (insideBox(b, [feet[0], feet[1] + 0.9, feet[2]], 0.35) || insideBox(b, [feet[0], feet[1] + 0.3, feet[2]], 0.35)))) {
        warnings.push(`出生點 ${hq}#${i} 與碰撞物重疊，已略過`);
        return;
      }
      const [cx, , cz] = toWorld(centre[0], centre[1], 0);
      const yaw = Math.atan2(-(cx - wx), -(cz - wz));
      spawnRoot.addChild(
        doc
          .createNode(`Spawn_${team}_${i}`)
          .setTranslation(feet)
          .setRotation(qYaw(yaw))
          .setExtras({ team, yaw_degrees: round((yaw * 180) / Math.PI, 2) }),
      );
      spawns++;
    });
  }

  const objectiveDefs: Array<[string, string, string]> = [
    ['A', 'Bridge', '橋梁'],
    ['B', 'Farmhouse', '農舍'],
    ['C', 'Ruins', '教堂遺跡'],
    ['D', 'Lumber_Camp', '伐木場'],
  ];
  for (const [id, siteName, display] of objectiveDefs) {
    const site = sites[siteName];
    if (!site) {
      warnings.push(`layout 缺少據點 ${siteName}`);
      continue;
    }
    const [wx, , wz] = toWorld(site.x, site.y, 0);
    const y = siteName === 'Bridge' ? layout.bridge.deck_z_m : groundAt(wx, wz);
    objectiveRoot.addChild(
      doc
        .createNode(`Objective_${id}`)
        .setTranslation([round(wx), round(y), round(wz)])
        .setExtras({ objective_id: id, display_name: display, radius: round(Math.min(site.radius + 6, 20), 1) }),
    );
  }

  // 敵方基地禁區：HQ_South 屬於 alpha，限制 bravo 進入（反之亦然）
  for (const [hq, team] of [
    ['HQ_South', 'bravo'],
    ['HQ_North', 'alpha'],
  ] as const) {
    const site = sites[hq];
    if (!site) continue;
    const [wx, wy, wz] = toWorld(site.x, site.y, site.z);
    const r = site.radius + 4;
    restrictedRoot.addChild(
      doc
        .createNode(`Restricted_${hq}`)
        .setTranslation([round(wx), round(wy), round(wz)])
        .setScale([r, 30, r])
        .setExtras({ team, grace_seconds: 5 }),
    );
  }

  const volumes = waterVolumes(src);
  volumes.forEach((v, i) => {
    waterRoot.addChild(
      doc
        .createNode(`Water_${i}`)
        .setTranslation([round((v.min[0] + v.max[0]) / 2), round((v.min[1] + v.max[1]) / 2), round((v.min[2] + v.max[2]) / 2)])
        .setScale([round((v.max[0] - v.min[0]) / 2), round((v.max[1] - v.min[1]) / 2), round((v.max[2] - v.min[2]) / 2)])
        .setExtras({ depth: v.deep ? 'deep' : 'shallow' }),
    );
  });

  // 太陽：Blender 燈光預設 noon（仰角 58°、方位 165°，方位由北順時針）
  const elevation = (58 * Math.PI) / 180;
  const azimuth = (165 * Math.PI) / 180;
  const sunDir: V3 = [-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
  lightingRoot.addChild(
    doc
      .createNode('Sun')
      .setRotation(qFromTo([0, 0, -1], sunDir))
      .setExtras({
        sky_color: '#9db6cf',
        fog_color: '#b7c6d4',
        fog_near: 90,
        fog_far: 520,
        sun_color: '#fff3e2',
        sun_intensity: 2.8,
        hemisphere_sky: '#d6e2ee',
        hemisphere_ground: '#4b4a36',
        hemisphere_intensity: 0.9,
      }),
  );

  // ---- 水面流向與深度（前端水面 shader 使用）----
  // 兩張都是不透明的 RGB：有些瀏覽器會把 alpha 為 0 的像素的 RGB 清掉，所以泡沫不放在 alpha
  const flowRaw = await sharp(src.files.flowMap).ensureAlpha().resize(1024, 1024).raw().toBuffer({ resolveWithObject: true });
  const pixels = flowRaw.info.width * flowRaw.info.height;
  const flowBytes = Buffer.alloc(pixels * 3);
  const depthBytes = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    flowBytes[i * 3] = flowRaw.data[i * 4]!;
    // Blender 的 G 是往北（+Y）；warfront 的北方是 −Z，所以反轉成「往 +Z」
    flowBytes[i * 3 + 1] = 255 - flowRaw.data[i * 4 + 1]!;
    flowBytes[i * 3 + 2] = flowRaw.data[i * 4 + 2]!;
    const r = Math.floor(i / flowRaw.info.width);
    const c = i % flowRaw.info.width;
    const x = -src.size / 2 + ((c + 0.5) / flowRaw.info.width) * src.size;
    const y = src.size / 2 - ((r + 0.5) / flowRaw.info.height) * src.size;
    depthBytes[i * 3] = Math.round(Math.min(1, src.waterDepth.sample(x, y) / src.waterScale.maxDepth) * 255);
    depthBytes[i * 3 + 1] = flowRaw.data[i * 4 + 3]!;
  }
  const raw = { width: flowRaw.info.width, height: flowRaw.info.height, channels: 3 as const };
  const flowPng = await sharp(flowBytes, { raw }).png({ compressionLevel: 9 }).toBuffer();
  const depthPng = await sharp(depthBytes, { raw }).png({ compressionLevel: 9 }).toBuffer();
  doc.createTexture('T_Water_Flow').setImage(flowPng).setMimeType('image/png');
  doc.createTexture('T_Water_Depth').setImage(depthPng).setMimeType('image/png');
  scene.setExtras({
    ...scene.getExtras(),
    frontline_water: {
      flow_texture: 'T_Water_Flow',
      depth_texture: 'T_Water_Depth',
      origin: [-src.size / 2, -src.size / 2],
      size: src.size,
      max_depth: round(src.waterScale.maxDepth, 3),
      max_speed: round(src.waterScale.maxSpeed, 3),
    },
  });

  // ---- 小地圖 ----
  log('產生小地圖');
  doc.createTexture('T_Minimap').setImage(await minimapImage(src, terrain, albedo, minimapTrees)).setMimeType('image/jpeg');
  scene.setExtras({ ...scene.getExtras(), frontline_minimap: { texture: 'T_Minimap', origin: [-src.size / 2, -src.size / 2], size: src.size } });

  // ---- 草地密度（前端 GPU 草地系統使用；顏色取地形底色貼圖）----
  log('產生草地密度圖');
  doc.createTexture('T_Grass_Density').setImage(await grassDensityMap(src, layout)).setMimeType('image/png');
  scene.setExtras({
    ...scene.getExtras(),
    frontline_grass: {
      density_texture: 'T_Grass_Density',
      color_texture: 'T_Terrain_Albedo',
      origin: [-src.size / 2, -src.size / 2],
      size: src.size,
    },
  });

  await doc.transform(unpartition());
  for (const b of doc.getRoot().listBuffers()) {
    if (b !== doc.getRoot().listBuffers()[0]) b.dispose();
  }
  mkdirSync(dirname(options.output), { recursive: true });
  log(`寫出 ${options.output}`);
  await io.write(options.output, doc);

  return {
    output: options.output,
    instances,
    colliders: boxes.length + 1,
    spawns,
    objectives: objectiveDefs.length,
    waterVolumes: volumes.length,
    lodTriangles,
    warnings,
  };
}

