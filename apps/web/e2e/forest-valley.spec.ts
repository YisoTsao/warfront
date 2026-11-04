import { expect, test, type Page } from '@playwright/test';
import { holdForSimSeconds, openGame, snapshot, startPlaying, teleportToGround } from './helpers';

/**
 * 森林谷地：由 blender-mcp-asset-generator 產生、bun run maps:forest 匯入的正式地圖。
 * 地形碰撞是高度場；樹木與岩石來自共用網格庫，貼圖共用，逐實例 LOD。
 */
test.describe.configure({ timeout: 240_000 });

const MAP = 'forest-valley';

async function waitStreamed(page: Page): Promise<void> {
  await expect.poll(() => snapshot(page).then((s) => s.streaming?.loading ?? -1), { timeout: 120_000, intervals: [2000] }).toBe(0);
}

test('載入森林谷地：出生在南方 HQ，共用網格庫與貼圖、逐實例 LOD', async ({ page }) => {
  const errors = await openGame(page, MAP);
  await waitStreamed(page);
  const s = await snapshot(page);
  expect(s.mapId).toBe(MAP);
  // 出生在南方 HQ（alpha）：z ≈ 145–165
  expect(s.feet.z).toBeGreaterThan(140);
  expect(s.feet.z).toBeLessThan(170);
  const ground = await page.evaluate(([x, z]) => window.__frontline!.groundHeight(x, z), [s.feet.x, s.feet.z] as const);
  expect(Math.abs(s.feet.y - ground!)).toBeLessThan(0.15);
  const stream = s.streaming!;
  expect(stream.failed).toBe(0);
  expect(stream.libraryMeshes).toBeGreaterThan(50);
  expect(stream.sharedTextures).toBeGreaterThanOrEqual(6);
  expect(stream.visibleInstances).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});

test('沿著道路走：高度場上移動速度正常、貼著地面', async ({ page }) => {
  await openGame(page, MAP);
  await waitStreamed(page);
  await startPlaying(page, 30_000);
  await teleportToGround(page, 2, 125, 0);
  const samples = await holdForSimSeconds(page, ['KeyW'], 3);
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const travelled = Math.hypot(last.x - first.x, last.z - first.z);
  expect(travelled).toBeGreaterThan(8);
  expect(samples.filter((p) => p.grounded).length / samples.length).toBeGreaterThan(0.9);
  const ground = await page.evaluate(([x, z]) => window.__frontline!.groundHeight(x, z), [last.x, last.z] as const);
  expect(Math.abs(last.y - ground!)).toBeLessThan(0.3);
});

test('地圖邊界擋住玩家；逐實例 LOD 依位置重新分配', async ({ page }) => {
  await openGame(page, MAP);
  await waitStreamed(page);
  await startPlaying(page, 30_000);
  const before = (await snapshot(page)).streaming!.visibleInstances;
  // 南邊河口附近的平地，往南（+Z）走向邊界
  await teleportToGround(page, 5, 243, Math.PI);
  await holdForSimSeconds(page, ['KeyW'], 4);
  const s = await snapshot(page);
  expect(s.feet.z).toBeLessThan(249.7);
  expect(s.feet.z).toBeGreaterThan(246);
  await expect.poll(() => snapshot(page).then((x) => x.streaming!.visibleInstances), { timeout: 30_000 }).not.toBe(before);
});

test('線上征服：森林谷地四個據點，部署後站在地形上', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const params = new URLSearchParams({ debug: '1', match: 'conquest', matchMap: MAP, bots: '4', guest: `pw-forest-${Date.now()}`, name: 'Forest' });
  await page.goto(`/?${params.toString()}`);
  await expect(page.getByTestId('deploy-screen')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /^部署/ }).click();
  await expect.poll(() => page.evaluate(() => (window.__frontline!.net!() as { life: string }).life), { timeout: 60_000 }).toBe('alive');
  await expect.poll(() => page.evaluate(() => window.__frontline!.hud().objectives.map((o) => o.id).join(',')), { timeout: 30_000 }).toBe('A,B,C,D');
  const s = await snapshot(page);
  const ground = await page.evaluate(([x, z]) => window.__frontline!.groundHeight(x, z), [s.feet.x, s.feet.z] as const);
  expect(Math.abs(s.feet.y - ground!)).toBeLessThan(0.3);
  expect(errors).toEqual([]);
  await page.evaluate(() => window.__frontline!.leave!());
  await context.close();
});
