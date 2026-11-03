import { expect, test } from '@playwright/test';
import { holdForSimSeconds, openGame, snapshot, startPlaying, teleportToGround, waitForPlayer, whileHolding } from './helpers';

/**
 * Phase 2：Blender GLB 經 map-build 轉換後的地圖（範例谷地）在瀏覽器中載入。
 * 執行前需要 `bun run maps:sample`（bun run e2e 會自動執行）。
 */

test.describe.configure({ timeout: 120_000 });

test('載入 GLB 地圖：地形分塊先載入，玩家站在地形上，沒有錯誤', async ({ page }) => {
  const errors = await openGame(page, 'sample-valley');
  const s = await snapshot(page);
  expect(s.mapId).toBe('sample-valley');
  expect(s.streaming).not.toBeNull();
  expect(s.streaming!.failed).toBe(0);
  expect(s.streaming!.loaded).toBeGreaterThanOrEqual(4);
  expect(s.grounded).toBe(true);
  expect(errors).toEqual([]);
});

test('樹木以 GPU instancing 繪製，且有 LOD', async ({ page }) => {
  await openGame(page, 'sample-valley');
  await expect.poll(() => page.evaluate(() => window.__frontline!.sceneInfo().instancedMeshes), { timeout: 30_000 }).toBeGreaterThan(4);
  const info = await page.evaluate(() => window.__frontline!.sceneInfo());
  expect(info.instances).toBeGreaterThan(50);
});

test('碰撞：房屋牆壁擋人、門口可以進出、鐵絲網擋人', async ({ page }) => {
  await openGame(page, 'sample-valley');
  await startPlaying(page);
  // House_1 在 (52, 38)，門朝 +Z（南方），寬 1.4 m；從門外往北走會進到屋內，再往北撞到後牆（z ≈ 35.3）。
  await teleportToGround(page, 52, 44, 0);
  const walk = await holdForSimSeconds(page, ['KeyW'], 4);
  const minZ = Math.min(...walk.map((s) => s.z));
  expect(minZ).toBeGreaterThan(35 + 0.3);
  expect(minZ).toBeLessThan(37);

  // 從牆外側往牆走會被擋住（右側牆 x ≈ 56）
  await teleportToGround(page, 60, 38, Math.PI / 2);
  const blocked = await holdForSimSeconds(page, ['KeyW'], 2);
  expect(Math.min(...blocked.map((s) => s.x))).toBeGreaterThan(56);

  // 鐵絲網（x 53–67, z = 30）擋人
  await teleportToGround(page, 60, 33, 0);
  const fence = await holdForSimSeconds(page, ['KeyW'], 2);
  expect(Math.min(...fence.map((s) => s.z))).toBeGreaterThan(30);
});

test('串流：移動到地圖另一端時載入附近分塊、卸載遠處分塊', async ({ page }) => {
  // 植被品質「低」：串流距離最短，方便觀察分塊載入與卸載
  await page.addInitScript(() => {
    window.localStorage.setItem('frontline.settings.v1', JSON.stringify({ foliageQuality: 'low', graphicsPreset: 'low' }));
  });
  await openGame(page, 'sample-valley');
  await startPlaying(page);
  const before = (await snapshot(page)).streaming!;
  await teleportToGround(page, 80, -80, 0);
  await expect.poll(() => snapshot(page).then((s) => s.streaming!.loading), { timeout: 30_000 }).toBe(0);
  await expect
    .poll(async () => {
      const after = (await snapshot(page)).streaming!;
      const added = after.loadedIds.filter((id) => !before.loadedIds.includes(id));
      const removed = before.loadedIds.filter((id) => !after.loadedIds.includes(id));
      return added.length > 0 && removed.length > 0;
    }, { timeout: 30_000 })
    .toBe(true);
  expect((await snapshot(page)).streaming!.failed).toBe(0);
});

test('地形上可以走動與爬坡，不會掉出地圖', async ({ page }) => {
  await openGame(page, 'sample-valley');
  await startPlaying(page);
  await teleportToGround(page, 0, 80, 0);
  const samples = await whileHolding(page, ['KeyW'], waitForPlayer(page, 's.feet.z < 60', 60_000));
  expect(Math.min(...samples.map((s) => s.y))).toBeGreaterThan(-20);
  expect(samples.filter((s) => s.grounded).length / samples.length).toBeGreaterThan(0.8);
});
