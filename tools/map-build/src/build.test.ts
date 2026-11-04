import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { parseMapCollision, parseMapManifest } from '@frontline/map-schema';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMap, type BuildReport } from './build';
import { generateSampleValley } from './sample/generateSampleValley';

const dir = mkdtempSync(join(tmpdir(), 'map-build-'));
const out = join(dir, 'out');
let report: BuildReport;

beforeAll(async () => {
  const input = await generateSampleValley(join(dir, 'sample.glb'));
  report = await buildMap({ input, outDir: out, id: 'sample-valley', name: '範例谷地' });
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('map-build（Blender GLB → 執行期地圖）', () => {
  it('產生通過 schema 驗證的 manifest 與碰撞資料', () => {
    const manifest = parseMapManifest(JSON.parse(readFileSync(join(out, 'map-manifest.json'), 'utf8')));
    const collision = parseMapCollision(JSON.parse(readFileSync(join(out, 'collision.json'), 'utf8')));
    expect(manifest.id).toBe('sample-valley');
    expect(collision.colliders.length).toBeGreaterThan(100);
    for (const chunk of manifest.chunks) {
      expect(existsSync(join(out, chunk.path))).toBe(true);
    }
  });

  it('從 GAMEPLAY_ 集合讀出出生點、據點、禁區與水域', () => {
    const manifest = parseMapManifest(JSON.parse(readFileSync(join(out, 'map-manifest.json'), 'utf8')));
    expect(manifest.spawns.filter((s) => s.team === 'alpha')).toHaveLength(8);
    expect(manifest.spawns.filter((s) => s.team === 'bravo')).toHaveLength(8);
    expect(manifest.objectives.map((o) => o.id).sort()).toEqual(['A', 'B', 'C']);
    expect(manifest.objectives.find((o) => o.id === 'B')?.name).toBe('石橋');
    expect(manifest.restrictedAreas.find((a) => a.id === 'Base_Alpha')?.team).toBe('bravo');
    expect(manifest.waterVolumes.some((w) => w.depth === 'deep')).toBe(true);
    // Alpha 出生點面向北方（-Z），yaw ≈ 0；Bravo 面向南方，yaw ≈ ±π
    expect(manifest.spawns.find((s) => s.team === 'alpha')!.yaw).toBeCloseTo(0, 3);
    expect(Math.abs(manifest.spawns.find((s) => s.team === 'bravo')!.yaw)).toBeCloseTo(Math.PI, 3);
  });

  it('光照參考轉成環境設定', () => {
    const manifest = parseMapManifest(JSON.parse(readFileSync(join(out, 'map-manifest.json'), 'utf8')));
    expect(manifest.environment.sunColor).toBe('#ffe9cc');
    const [x, y, z] = manifest.environment.sunDirection;
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 3);
    expect(y).toBeLessThan(0);
  });

  it('碰撞：方塊、地形三角網格、只擋移動的鐵絲網', () => {
    const collision = parseMapCollision(JSON.parse(readFileSync(join(out, 'collision.json'), 'utf8')));
    expect(report.colliders.trimeshes).toBe(4);
    const fence = collision.colliders.find((c) => c.name === 'Fence_ChainLink_Col');
    expect(fence?.layer).toBe('movement');
    expect(fence?.kind).toBe('box');
    if (fence?.kind === 'box') {
      expect(fence.halfExtents[0]).toBeCloseTo(7);
    }
  });

  it('地形分塊永遠載入，細節分塊依距離串流', () => {
    const manifest = parseMapManifest(JSON.parse(readFileSync(join(out, 'map-manifest.json'), 'utf8')));
    const terrain = manifest.chunks.filter((c) => c.id.startsWith('terrain'));
    const detail = manifest.chunks.filter((c) => c.id.startsWith('detail'));
    expect(terrain.length).toBeGreaterThan(0);
    expect(terrain.every((c) => c.priority === 0 && c.streamDistance === undefined)).toBe(true);
    expect(detail.every((c) => c.streamDistance !== undefined)).toBe(true);
  });

  it('樹木合併為 GPU instancing，並附上 LOD1', async () => {
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const manifest = parseMapManifest(JSON.parse(readFileSync(join(out, 'map-manifest.json'), 'utf8')));
    let lod0 = 0;
    let lod1 = 0;
    for (const chunk of manifest.chunks.filter((c) => c.id.startsWith('detail'))) {
      const doc = await io.read(join(out, chunk.path));
      for (const node of doc.getRoot().listNodes()) {
        const extras = node.getExtras();
        if (node.getExtension('EXT_mesh_gpu_instancing') && extras.lod_group === 'Pine') {
          if (extras.lod_level === 0) {
            lod0 += Number(extras.instance_count);
          } else {
            lod1 += Number(extras.instance_count);
          }
        }
      }
    }
    expect(lod0).toBeGreaterThan(300);
    expect(lod1).toBe(lod0);
  });
});

/**
 * 高度場、共用貼圖與共用網格庫：用一個小型合成場景驗證（森林谷地匯入使用的功能）。
 */
describe('map-build：高度場、共用貼圖、共用網格庫', () => {
  const sharedDir = mkdtempSync(join(tmpdir(), 'map-build-shared-'));
  const sharedOut = join(sharedDir, 'out');
  let sharedReport: BuildReport;
  beforeAll(async () => {
    // 4×4 有變化的貼圖（單色貼圖會被 prune 當成純色而移除）
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let i = 0; i < 16; i++) pixels.set([i * 16, 255 - i * 16, 40, i % 2 ? 255 : 0], i * 4);
    const png = new Uint8Array(await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer());
    const { Document } = await import('@gltf-transform/core');
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene();
    doc.getRoot().setDefaultScene(scene);
    scene.setExtras({ frontline_build: { chunk_size: 64, shared_library: true, lod_distances: [30] } });
    const acc = (type: 'VEC2' | 'VEC3' | 'SCALAR', array: Float32Array | Uint32Array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);

    // 地形：9×9 樣本、40 m 見方，同時當視覺網格與高度場
    const rows = 9;
    const positions = new Float32Array(rows * rows * 3);
    for (let r = 0; r < rows; r++) for (let c = 0; c < rows; c++) positions.set([-20 + c * 5, Math.sin(c) + r * 0.25, -20 + r * 5], (r * rows + c) * 3);
    const terrainIndices: number[] = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < rows - 1; c++) {
      const a = r * rows + c;
      terrainIndices.push(a, a + rows, a + 1, a + 1, a + rows, a + rows + 1);
    }
    const terrainMesh = doc.createMesh('Terrain').addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc('VEC3', positions)).setIndices(acc('SCALAR', Uint32Array.from(terrainIndices))));
    const envTerrain = doc.createNode('ENV_Terrain').addChild(doc.createNode('Terrain').setMesh(terrainMesh));
    const grid = doc.createMesh('COL_Grid').addPrimitive(doc.createPrimitive().setMode(0).setAttribute('POSITION', acc('VEC3', positions)));
    const collision = doc
      .createNode('COLLISION_Static')
      .addChild(doc.createNode('COL_Terrain').setMesh(grid).setExtras({ collider: 'heightfield', grid_rows: rows, grid_cols: rows }))
      .addChild(doc.createNode('COL_Bad').setMesh(grid).setExtras({ collider: 'heightfield', grid_rows: 3, grid_cols: 3 }));

    // 有貼圖的灌木（LOD0 + LOD1），擺 6 棵
    const texture = doc.createTexture('T_Leaf').setImage(png).setMimeType('image/png');
    const leaf = doc.createMaterial('M_Leaf').setBaseColorTexture(texture).setAlphaMode('MASK');
    const quad = (name: string) =>
      doc.createMesh(name).addPrimitive(
        doc
          .createPrimitive()
          .setAttribute('POSITION', acc('VEC3', new Float32Array([-1, 0, 0, 1, 0, 0, 1, 2, 0, -1, 2, 0])))
          .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])))
          .setIndices(acc('SCALAR', new Uint32Array([0, 1, 2, 0, 2, 3])))
          .setMaterial(leaf),
      );
    const bush = quad('Bush_LOD0');
    quad('Bush_LOD1');
    const foliage = doc.createNode('ENV_Foliage');
    for (let i = 0; i < 6; i++) foliage.addChild(doc.createNode(`Bush_${i}`).setMesh(bush).setTranslation([-15 + i * 6, 2, 3]));
    const spawns = doc.createNode('GAMEPLAY_SpawnPoints').addChild(doc.createNode('Spawn').setTranslation([0, 1, 0]));
    for (const node of [envTerrain, collision, foliage, spawns]) scene.addChild(node);
    const input = join(sharedDir, 'shared.glb');
    await new NodeIO().write(input, doc);
    sharedReport = await buildMap({ input, outDir: sharedOut, id: 'shared-test', name: 'shared' });
  }, 60_000);

  afterAll(() => rmSync(sharedDir, { recursive: true, force: true }));

  it('規則格網轉成高度場；不規則的格網跳過並警告', () => {
    const collision = parseMapCollision(JSON.parse(readFileSync(join(sharedOut, 'collision.json'), 'utf8')));
    const fields = collision.colliders.filter((c) => c.kind === 'heightfield');
    expect(fields).toHaveLength(1);
    const field = fields[0]!;
    expect(field.kind === 'heightfield' && [field.rows, field.cols, field.origin[0], field.size[0]]).toEqual([9, 9, -20, 40]);
    expect(sharedReport.colliders.heightfields).toBe(1);
    expect(sharedReport.warnings.some((w) => w.includes('COL_Bad'))).toBe(true);
  });

  it('貼圖只寫一次到 textures/，材質改記路徑，UV 保留', async () => {
    expect(sharedReport.textures).toHaveLength(1);
    expect(sharedReport.textures[0]!.path).toMatch(/^textures\/T_Leaf-[0-9a-f]{10}\.png$/);
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const library = await io.read(join(sharedOut, 'library.glb'));
    expect(library.getRoot().listTextures()).toHaveLength(0);
    const mesh = library.getRoot().listMeshes().find((m) => m.getName() === 'Bush_LOD0')!;
    const prim = mesh.listPrimitives()[0]!;
    expect(prim.getAttribute('TEXCOORD_0')).not.toBeNull();
    expect(prim.getMaterial()!.getExtras().frontline_textures).toEqual({ map: sharedReport.textures[0]!.path });
  });

  it('重複網格（含 LOD1）放進共用網格庫，分塊只放實例與佔位網格', async () => {
    const manifest = parseMapManifest(JSON.parse(readFileSync(join(sharedOut, 'map-manifest.json'), 'utf8')));
    expect(manifest.library?.path).toBe('library.glb');
    expect(sharedReport.library?.meshes).toBe(2);
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    let instances = 0;
    for (const chunk of manifest.chunks.filter((c) => c.id.startsWith('detail'))) {
      const doc = await io.read(join(sharedOut, chunk.path));
      for (const node of doc.getRoot().listNodes()) {
        const batch = node.getExtension<import('@gltf-transform/extensions').InstancedMesh>('EXT_mesh_gpu_instancing');
        if (!batch || node.getExtras().lod_level !== 0) continue;
        expect(node.getExtras().library_mesh).toBe('Bush_LOD0');
        const scale = batch.getAttribute('SCALE')!;
        const s: number[] = [];
        for (let i = 0; i < scale.getCount(); i++) {
          // 量化不能把實例縮成 0（佔位網格的包圍盒必須是 [-1, 1]）
          scale.getElement(i, s);
          expect(s[0]).toBeCloseTo(1, 2);
        }
        instances += scale.getCount();
      }
      expect(doc.getRoot().listMeshes().some((m) => m.getName() === 'Bush_LOD0')).toBe(false);
    }
    expect(instances).toBe(6);
  });
});
