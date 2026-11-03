import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { parseMapCollision, parseMapManifest } from '@frontline/map-schema';
import { MeshoptDecoder } from 'meshoptimizer';
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
