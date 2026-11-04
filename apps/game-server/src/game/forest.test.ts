/**
 * 森林谷地（blender-mcp-asset-generator 產生、bun run maps:forest 匯入）的整合測試：
 * 地圖資料是否可用、出生點與據點是否在地面上、bot 在真實地形上能否移動、交戰與佔點。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heightfieldHeightAt, pointInBounds, type HeightfieldColliderData } from '@frontline/map-schema';
import { TICK_RATE } from '@frontline/shared';
import { initPhysics, loadMapData, SimWorld, type LoadedMapData } from '@frontline/simulation';
import { beforeAll, describe, expect, it } from 'vitest';
import { Match } from './Match';

const MAPS_DIR = resolve(import.meta.dirname, '../../../../assets/maps');
const available = existsSync(resolve(MAPS_DIR, 'forest-valley/map-manifest.json'));

let map: LoadedMapData;
let terrain: HeightfieldColliderData;

beforeAll(async () => {
  if (!available) {
    return;
  }
  await initPhysics();
  map = await loadMapData('forest-valley', MAPS_DIR, async (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown);
  terrain = map.collision.colliders.find((c): c is HeightfieldColliderData => c.kind === 'heightfield')!;
});

describe.skipIf(!available)('森林谷地地圖資料', () => {
  it('地形是高度場，兩隊各有出生點，四個征服據點', () => {
    expect(terrain).toBeDefined();
    expect(terrain.rows * terrain.cols).toBe(terrain.heights.length);
    expect(map.manifest.spawns.filter((s) => s.team === 'alpha').length).toBeGreaterThanOrEqual(4);
    expect(map.manifest.spawns.filter((s) => s.team === 'bravo').length).toBeGreaterThanOrEqual(4);
    expect(map.manifest.objectives.map((o) => o.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(map.manifest.library).toBeDefined();
    expect(map.manifest.waterVolumes.length).toBeGreaterThan(50);
  });

  it('出生點貼著地面（離地形不超過 10 cm）', () => {
    for (const spawn of map.manifest.spawns) {
      const ground = heightfieldHeightAt(terrain, spawn.position[0], spawn.position[2])!;
      expect(Math.abs(spawn.position[1] - ground)).toBeLessThan(0.1);
    }
  });

  it('據點在可站立的位置（地面或橋面上）', () => {
    const world = new SimWorld(map.manifest, map.collision, 1 / TICK_RATE);
    for (const objective of map.manifest.objectives) {
      // 由上往下打，第一個命中的高度要接近據點高度（橋上的據點會先打到橋面）
      const hit = world.castBullet({ x: objective.position[0], y: objective.position[1] + 3, z: objective.position[2] }, { x: 0, y: -1, z: 0 }, 10);
      expect(hit, objective.id).not.toBeNull();
      expect(Math.abs(hit!.point.y - objective.position[1]), objective.id).toBeLessThan(1);
    }
    world.dispose();
  });

  it('敵方基地禁區只限制對方隊伍', () => {
    const south = map.manifest.restrictedAreas.find((a) => a.id.includes('HQ_South'))!;
    const alphaSpawn = map.manifest.spawns.find((s) => s.team === 'alpha')!;
    expect(south.team).toBe('bravo');
    expect(pointInBounds({ x: alphaSpawn.position[0], y: alphaSpawn.position[1], z: alphaSpawn.position[2] }, south.bounds)).toBe(true);
  });
});

describe.skipIf(!available)('森林谷地對戰（16 個 bot）', () => {
  it('征服模式 90 秒：bot 會移動、交戰、佔點，沒有人掉出地形', () => {
    const match = new Match({ map, mode: 'conquest', botFill: 16, seed: 42, warmupSeconds: 0 });
    const start = new Map<number, { x: number; z: number }>();
    let worst = 0;
    let total = 0;
    const ticks = 90 * TICK_RATE;
    for (let i = 0; i < ticks; i++) {
      const t0 = performance.now();
      match.step();
      const ms = performance.now() - t0;
      total += ms;
      worst = Math.max(worst, ms);
      if (i === TICK_RATE * 2) {
        for (const p of match.players.values()) {
          if (p.body) start.set(p.number, { x: p.body.position.x, z: p.body.position.z });
        }
      }
      if (i % TICK_RATE === 0) {
        for (const p of match.players.values()) {
          if (!p.body || !p.alive) continue;
          const ground = heightfieldHeightAt(terrain, p.body.position.x, p.body.position.z);
          if (ground !== null) {
            expect(p.body.position.y, `bot ${p.number}`).toBeGreaterThan(ground - 0.6);
          }
        }
      }
    }
    const moved = [...match.players.values()].filter((p) => {
      const s = start.get(p.number);
      return s && p.body && Math.hypot(p.body.position.x - s.x, p.body.position.z - s.z) > 15;
    });
    const board = match.scoreboard();
    const state = match.matchState();
    const captured = state.objectives?.filter((o) => o.owner !== null && o.owner !== undefined).length ?? 0;
    console.log(
      `森林谷地 90 秒：tick 平均 ${(total / ticks).toFixed(2)} ms、最大 ${worst.toFixed(1)} ms；移動超過 15 m 的 bot ${moved.length}/16；` +
        `擊殺 ${board.reduce((s, p) => s + p.kills, 0)}；已佔領據點 ${captured}`,
    );
    expect(moved.length).toBeGreaterThanOrEqual(10);
    expect(captured).toBeGreaterThanOrEqual(1);
    expect(total / ticks).toBeLessThan(15);
    match.dispose();
  }, 120_000);
});
