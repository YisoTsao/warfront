import { expect, test } from '@playwright/test';
import {
  STEPS_PER_SECOND,
  holdForSimSeconds,
  maxHeightDrop,
  openGame,
  snapshot,
  startPlaying,
  teleport,
  waitForPlayer,
  whileHolding,
} from './helpers';

/**
 * 對應 docs/FRONTLINE_WEB_PROJECT_SPEC.md §19「Phase 1 verification checklist」。
 * 移動相關的判斷都以「模擬步驟」紀錄為準，渲染很慢的機器（軟體繪圖）也能得到一致結果。
 */

const WALK_SPEED = 3.6;
const SPRINT_SPEED = 6.0;
const PITCH_LIMIT = (89 * Math.PI) / 180;
/** 面向 +X 的 yaw */
const FACE_EAST = -Math.PI / 2;

test('載入時檢查並回報 WebGL 2，沒有錯誤', async ({ page }) => {
  const errors = await openGame(page);
  await expect(page.getByRole('button', { name: '點擊開始' })).toBeVisible();
  await expect(page.locator('pre.diagnostics')).toContainText('WebGL 2', { timeout: 10_000 });
  await expect.poll(() => snapshot(page).then((s) => s.stats.drawCalls)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('Pointer Lock 只在點擊後啟動，鎖定前不接受移動輸入', async ({ page }) => {
  await openGame(page);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  const idle = await holdForSimSeconds(page, ['KeyW'], 0.5);
  expect(Math.max(...idle.map((s) => s.speed))).toBe(0);
  expect((await snapshot(page)).pointerLocked).toBe(false);

  await startPlaying(page);
  expect(await page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');
});

test('滑鼠視角：左右轉向正確，上下夾在 ±89 度不翻轉', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await page.evaluate(() => window.__frontline!.setView(0, 0));
  // 無頭 Chromium 在 Pointer Lock 下會把游標拉回中心，Playwright 的 mouse.move 淨位移為 0；
  // 因此直接派送帶有 movementX/Y 的 mousemove 事件，仍經過遊戲實際的輸入處理流程。
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100 })));
  // 滑鼠往右 → 向右轉 → yaw 減少（下一個渲染畫格套用）
  await expect.poll(() => snapshot(page).then((s) => s.yaw)).toBeCloseTo(-0.22, 3);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: -100 })));
  await expect.poll(() => snapshot(page).then((s) => s.yaw)).toBeCloseTo(0, 3);

  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementY: -100000 })));
  await expect.poll(() => snapshot(page).then((s) => s.pitch)).toBeCloseTo(PITCH_LIMIT, 4);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementY: 200000 })));
  await expect.poll(() => snapshot(page).then((s) => s.pitch)).toBeCloseTo(-PITCH_LIMIT, 4);
});

test('WASD 移動方向正確，走路速度約 3.6 m/s', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, 0, 0, 12, 0);
  const forward = await whileHolding(page, ['KeyW'], waitForPlayer(page, 's.feet.z < 8'));
  expect(Math.abs(forward.at(-1)!.x)).toBeLessThan(0.05);
  const top = Math.max(...forward.map((s) => s.speed));
  expect(top).toBeGreaterThan(WALK_SPEED - 0.1);
  expect(top).toBeLessThan(WALK_SPEED + 0.05);

  await teleport(page, 0, 0, 12, 0);
  const strafe = await whileHolding(page, ['KeyD'], waitForPlayer(page, 's.feet.x > 1'));
  expect(Math.abs(strafe.at(-1)!.z - 12)).toBeLessThan(0.05);
});

test('衝刺：往前時達到約 6 m/s，後退時不能衝刺', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, 0, 0, 12, 0);
  const sprint = await whileHolding(page, ['ShiftLeft', 'KeyW'], waitForPlayer(page, 's.feet.z < 2'));
  const top = Math.max(...sprint.map((s) => s.speed));
  expect(top).toBeGreaterThan(SPRINT_SPEED - 0.1);
  expect(top).toBeLessThan(SPRINT_SPEED + 0.05);

  await teleport(page, 0, 0, -10, 0);
  const backwards = await holdForSimSeconds(page, ['ShiftLeft', 'KeyS'], 1.5);
  expect(Math.max(...backwards.map((s) => s.speed))).toBeLessThan(WALK_SPEED + 0.05);
});

test('跳躍：高度約 0.74 m，按住空白鍵不會連跳', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, 0, 0, 12, 0);
  const groundY = (await snapshot(page)).feet.y;

  const held = await holdForSimSeconds(page, ['Space'], 2.5);
  const peak = Math.max(...held.map((s) => s.y)) - groundY;
  expect(peak).toBeGreaterThan(0.68);
  expect(peak).toBeLessThan(0.8);
  let takeoffs = 0;
  for (let i = 1; i < held.length; i++) {
    if (held[i - 1]!.grounded && !held[i]!.grounded) {
      takeoffs++;
    }
  }
  // 第一步可能已經離地（按下後的第一個模擬步就起跳）。
  if (held.length > 0 && !held[0]!.grounded) {
    takeoffs++;
  }
  expect(takeoffs).toBe(1);
  const end = held.at(-1)!;
  expect(end.grounded).toBe(true);
  expect(Math.abs(end.y - groundY)).toBeLessThan(0.02);
});

test('蹲下：膠囊高度切換，腳底位置不變；低矮通道內無法站起', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, 0, 0, 12, 0);
  const standingY = (await snapshot(page)).feet.y;

  await page.keyboard.press('KeyC');
  await expect.poll(() => snapshot(page).then((s) => s.stance)).toBe('crouching');
  const crouched = await holdForSimSeconds(page, [], 0.3);
  expect(crouched.every((s) => s.grounded && Math.abs(s.y - standingY) < 0.02)).toBe(true);

  await page.keyboard.press('KeyC');
  await expect.poll(() => snapshot(page).then((s) => s.stance)).toBe('standing');
  const stood = await holdForSimSeconds(page, [], 0.3);
  expect(stood.every((s) => s.grounded && Math.abs(s.y - standingY) < 0.02)).toBe(true);

  // 站姿走不進淨高 1.4 m 的通道（入口 z = -1）。
  await teleport(page, 22, 0, 1.5, 0);
  const blocked = await holdForSimSeconds(page, ['KeyW'], 1.5);
  expect(Math.min(...blocked.map((s) => s.z))).toBeGreaterThan(-0.9);

  // 蹲姿進入通道；在通道內放開蹲下，頭頂空間不足所以維持蹲姿；走出通道後自動站起。
  await page.keyboard.press('KeyC');
  await expect.poll(() => snapshot(page).then((s) => s.stance)).toBe('crouching');
  await whileHolding(page, ['KeyW'], waitForPlayer(page, 's.feet.z < -3'));
  await page.keyboard.press('KeyC');
  const inside = await holdForSimSeconds(page, [], 0.5);
  expect(inside.every((s) => s.stance === 'crouching')).toBe(true);
  await whileHolding(page, ['KeyS'], waitForPlayer(page, "s.stance === 'standing'"));
  expect((await snapshot(page)).feet.z).toBeGreaterThan(-1);
});

test('牆壁與地板：走不穿牆、不會掉出地板', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, 0, 0, -55, 0);
  const samples = await holdForSimSeconds(page, ['ShiftLeft', 'KeyW'], 2.5);
  // 北側外牆內面在 z = -60，膠囊半徑 0.34。
  expect(Math.min(...samples.map((s) => s.z))).toBeGreaterThan(-60 + 0.3);
  expect(Math.min(...samples.map((s) => s.y))).toBeGreaterThan(-0.05);
  // 頂著牆時位置穩定。
  const last = samples.slice(-STEPS_PER_SECOND);
  expect(Math.max(...last.map((s) => s.z)) - Math.min(...last.map((s) => s.z))).toBeLessThan(0.01);
});

const CLIMBABLE = [
  { name: '15° 坡道', x: -36, topY: 8 * Math.sin((15 * Math.PI) / 180) },
  { name: '30° 坡道', x: -29, topY: 8 * Math.sin((30 * Math.PI) / 180) },
  { name: '40° 坡道', x: -22, topY: 8 * Math.sin((40 * Math.PI) / 180) },
  { name: '樓梯（每階 0.18 m）', x: -6, topY: 1.8 },
];

for (const target of CLIMBABLE) {
  test(`${target.name}：可以走上去，高度平順上升不回落`, async ({ page }) => {
    await openGame(page);
    await startPlaying(page);
    await teleport(page, target.x, 0, 2, 0);
    const climb = await whileHolding(page, ['KeyW'], waitForPlayer(page, `s.feet.y > ${target.topY - 0.05}`));
    expect(maxHeightDrop(climb)).toBeLessThan(0.01);
    // 爬升途中不能卡住：實際水平速度低於 0.5 m/s 的步數最多 3 步（自動跨步時可能停頓一步）。
    const climbing = climb.filter((s) => s.y > 0.1 && s.y < target.topY - 0.1);
    expect(climbing.filter((s) => s.speed < 0.5).length).toBeLessThanOrEqual(3);
    // 平均水平速度至少是走路速度的一半（陡坡上實際水平位移會變短）。
    const average = climbing.reduce((sum, s) => sum + s.speed, 0) / climbing.length;
    expect(average).toBeGreaterThan(WALK_SPEED / 2);
  });
}

test('55° 坡道：超過爬坡上限，走不上去', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, -15, 0, 2, 0);
  const samples = await holdForSimSeconds(page, ['KeyW'], 3);
  expect(Math.max(...samples.map((s) => s.y))).toBeLessThan(1);
});

test('銳角牆角：推進牆角時不抖動、不穿牆', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await teleport(page, -4, 0, 26.1, FACE_EAST);
  // W + D 往 +X、+Z 斜推，會沿著斜牆滑進 30° 牆角尖端。
  const samples = await whileHolding(page, ['KeyW', 'KeyD'], async () => {
    await waitForPlayer(page, 'Math.hypot(s.velocity.x, s.velocity.z) < 0.01', 45_000)();
    await page.waitForFunction(
      (target) => window.__frontline!.recordedStepCount() >= target,
      // 停下來之後再推 1 秒，檢查是否抖動。
      (await page.evaluate(() => window.__frontline!.recordedStepCount())) + STEPS_PER_SECOND,
    );
  });
  const settled = samples.slice(-STEPS_PER_SECOND);
  const xs = settled.map((s) => s.x);
  const zs = settled.map((s) => s.z);
  expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.01);
  expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(0.01);
  // 仍在兩面牆之間：牆 A 北面 z = 25.25，牆角尖端在 x = 0。
  expect(Math.min(...samples.map((s) => s.z))).toBeGreaterThan(25.25);
  expect(Math.max(...samples.map((s) => s.x))).toBeLessThan(0);
});

test('暫停與繼續：釋放滑鼠後顯示選單、不接受輸入，點擊後安全恢復', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.getByRole('button', { name: '繼續遊戲' })).toBeVisible();
  expect((await snapshot(page)).pointerLocked).toBe(false);

  const paused = await holdForSimSeconds(page, ['KeyW'], 0.5);
  expect(Math.max(...paused.map((s) => s.speed))).toBe(0);

  // Chrome 在離開鎖定後約一秒內會拒絕重新鎖定。
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '繼續遊戲' }).click();
  await expect.poll(() => snapshot(page).then((s) => s.pointerLocked)).toBe(true);
  await expect(page.getByRole('button', { name: '繼續遊戲' })).toBeHidden();
  const resumed = await whileHolding(page, ['KeyW'], waitForPlayer(page, 's.locomotion === "walking"'));
  expect(resumed.length).toBeGreaterThan(0);
});

test('3D 渲染迴圈不會造成 React 持續重新渲染', async ({ page }) => {
  await openGame(page);
  await startPlaying(page);
  await page.evaluate(() => {
    const w = window as unknown as { __mutations: number };
    w.__mutations = 0;
    const diagnostics = document.querySelector('.diagnostics');
    new MutationObserver((records) => {
      for (const record of records) {
        // 效能面板由遊戲迴圈直接寫入 DOM，不經過 React，不列入計算。
        if (!diagnostics?.contains(record.target)) {
          w.__mutations++;
        }
      }
    }).observe(document.getElementById('root')!, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await holdForSimSeconds(page, ['KeyW'], 2);
  expect(await page.evaluate(() => (window as unknown as { __mutations: number }).__mutations)).toBe(0);
});

test('設定：視野與靈敏度會保存，重新整理後仍有效', async ({ page }) => {
  await openGame(page);
  await page.getByRole('slider', { name: /水平視野/ }).fill('100');
  await page.getByRole('slider', { name: /滑鼠靈敏度/ }).fill('2');
  await expect(page.getByText('100°')).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.__frontline !== undefined);
  await expect(page.getByRole('slider', { name: /水平視野/ })).toHaveValue('100');
  await expect(page.getByRole('slider', { name: /滑鼠靈敏度/ })).toHaveValue('2');
});
