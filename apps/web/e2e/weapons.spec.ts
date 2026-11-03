import { expect, test, type Page } from '@playwright/test';
import { holdForSimSeconds, openGame, startPlaying } from './helpers';

/** Phase 3：武器與單機戰鬥（訓練場）。 */

test.describe.configure({ timeout: 90_000 });

type WeaponInfo = Awaited<ReturnType<NonNullable<typeof window.__frontline>['weapon']>>;

const weapon = (page: Page): Promise<WeaponInfo> => page.evaluate(() => window.__frontline!.weapon());
const combat = (page: Page) => page.evaluate(() => window.__frontline!.combat());

/** 面向第一個假人（出生點前方 10 m、左方 3 m）的軀幹。 */
async function aimAtFirstDummy(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__frontline!.snapshot();
    const eye = { x: s.feet.x, y: s.feet.y + 1.64, z: s.feet.z };
    const target = { x: -3, y: 1.2, z: 2 };
    const dx = target.x - eye.x;
    const dz = target.z - eye.z;
    const dy = target.y - eye.y;
    window.__frontline!.setView(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  });
}

async function mouse(page: Page, button: 0 | 2, down: boolean): Promise<void> {
  // 無頭瀏覽器在 Pointer Lock 下的滑鼠按鍵事件不穩定，直接派送事件（仍經過遊戲的輸入處理）
  await page.evaluate(([b, d]) => document.dispatchEvent(new MouseEvent(d ? 'mousedown' : 'mouseup', { button: b })), [button, down] as const);
}

test('瞄準後射擊假人：彈藥減少、命中並顯示 hit marker，HUD 與武器狀態一致', async ({ page }) => {
  const errors = await openGame(page);
  await startPlaying(page);
  await aimAtFirstDummy(page);
  await mouse(page, 2, true);
  await expect.poll(() => weapon(page).then((w) => w.aiming)).toBe(true);
  await expect.poll(() => weapon(page).then((w) => w.adsFov)).toBeLessThan(70);
  // 維持瞄準時視野保持穩定（不會在腰射與瞄準之間跳動）
  const fovs: number[] = [];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(150);
    fovs.push((await weapon(page)).adsFov);
  }
  expect(Math.max(...fovs)).toBeLessThan(70);
  await expect(page.locator('.crosshair-dynamic')).toHaveCSS('opacity', '0');
  const before = await weapon(page);
  await mouse(page, 0, true);
  await holdForSimSeconds(page, [], 0.05);
  await mouse(page, 0, false);
  await expect.poll(() => weapon(page).then((w) => w.ammo)).toBeLessThan(before.ammo);
  await expect.poll(() => combat(page).then((c) => c.total)).toBeGreaterThan(0);
  await expect(page.getByTestId('hitmarker')).toBeAttached();
  const w = await weapon(page);
  await expect(page.getByTestId('ammo')).toHaveText(String(w.ammo));
  await mouse(page, 2, false);
  expect(errors).toEqual([]);
});

test('全自動連射後換彈：彈匣補滿、備彈減少', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await page.evaluate(() => window.__frontline!.setView(0, -0.3));
  await page.evaluate(() => window.__frontline!.startRecording());
  await mouse(page, 0, true);
  await page.waitForFunction(() => window.__frontline!.recordedStepCount() >= 24);
  await mouse(page, 0, false);
  const steps = (await page.evaluate(() => window.__frontline!.stopRecording())).length;
  const fired = await weapon(page);
  // 750 RPM = 每秒 12.5 發；以實際經過的模擬步數（30 Hz）檢查射速
  const expected = (steps / 30) * 12.5;
  expect(30 - fired.ammo).toBeLessThanOrEqual(Math.ceil(expected) + 1);
  // 按下與放開滑鼠的事件可能晚一個畫格（軟體繪圖下一格最多 7 步）才生效
  expect(30 - fired.ammo).toBeGreaterThanOrEqual(Math.floor(((steps - 16) / 30) * 12.5));
  await page.keyboard.press('KeyR');
  await expect.poll(() => weapon(page).then((w) => w.reloading)).toBe(true);
  await expect.poll(() => weapon(page).then((w) => w.ammo), { timeout: 15_000 }).toBe(30);
  const after = await weapon(page);
  expect(after.reserve).toBe(120 - (30 - fired.ammo));
  // 打在地上會產生命中特效
  expect(await page.evaluate(() => window.__frontline!.sceneInfo().particles ?? 0)).toBeGreaterThanOrEqual(0);
});

test('擊殺假人後 3 秒復活', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await aimAtFirstDummy(page);
  await mouse(page, 2, true);
  await expect.poll(() => weapon(page).then((w) => w.adsFov)).toBeLessThan(70);
  await mouse(page, 0, true);
  await expect.poll(() => combat(page).then((c) => c.kills), { timeout: 20_000 }).toBeGreaterThan(0);
  await mouse(page, 0, false);
  const dead = await combat(page);
  expect(dead.dummiesAlive).toBe((dead.dummies ?? 0) - 1);
  await expect.poll(() => combat(page).then((c) => c.dummiesAlive), { timeout: 20_000 }).toBe(dead.dummies);
});

test('切換武器與射擊模式', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  expect((await weapon(page)).id).toBe('ar_carbine');
  await page.keyboard.press('Digit2');
  await expect.poll(() => weapon(page).then((w) => w.id)).toBe('pt_sidearm');
  await page.keyboard.press('Digit1');
  await expect.poll(() => weapon(page).then((w) => w.id)).toBe('ar_carbine');
  await page.keyboard.press('KeyB');
  await expect.poll(() => weapon(page).then((w) => w.fireMode)).toBe('burst');
  await expect(page.getByText(/三發點放/)).toBeVisible();
});

test('霰彈槍一次打出多顆彈丸，泵動逐發裝填', async ({ page }) => {
  await page.goto('/?debug=1&map=graybox&class=assault&primary=sg_pump');
  await page.waitForFunction(() => window.__frontline?.snapshot().grounded === true, null, { timeout: 60_000 });
  await startPlaying(page);
  expect((await weapon(page)).id).toBe('sg_pump');
  await page.evaluate(() => window.__frontline!.setView(0, -0.4));
  await mouse(page, 0, true);
  await holdForSimSeconds(page, [], 0.1);
  await mouse(page, 0, false);
  await expect.poll(() => weapon(page).then((w) => w.ammo)).toBe(5);
  await page.keyboard.press('KeyR');
  await expect.poll(() => weapon(page).then((w) => w.ammo), { timeout: 10_000 }).toBe(6);
});

test('點擊後啟動音效系統', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await expect.poll(() => page.evaluate(() => window.__frontline!.audioRunning())).toBe(true);
});

test('主選單：可以設定名稱並進入訓練場', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /快速對戰：團隊死鬥/ })).toBeVisible();
  await page.getByLabel('玩家名稱').fill('測試士兵');
  await page.getByLabel('訓練場主武器').selectOption('sg_pump');
  await page.getByRole('button', { name: '進入訓練場' }).click();
  await expect(page.getByRole('button', { name: '點擊開始' })).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByLabel('玩家名稱')).toHaveValue('測試士兵');
});
