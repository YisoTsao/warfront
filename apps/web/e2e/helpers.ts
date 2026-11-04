import { TICK_RATE } from '@frontline/shared';
import { expect, type Page } from '@playwright/test';
import type { FrontlineDebugHook, StepSample } from '../src/game/debug/debugHook';

export type Snapshot = ReturnType<FrontlineDebugHook['snapshot']>;
export type { StepSample };

/** 模擬頻率：與伺服器 tick 相同 */
export const STEPS_PER_SECOND = TICK_RATE;

/** 開啟遊戲並等待載入完成（尚未鎖定滑鼠）。回傳收集頁面錯誤的陣列。 */
export async function openGame(page: Page, mapId = 'graybox'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  await page.goto(`/?debug=1&map=${mapId}`);
  await page.waitForFunction(() => window.__frontline !== undefined, null, { timeout: 60_000 });
  // 讓物理先跑幾步，角色落到地面。
  await page.waitForFunction(() => window.__frontline?.snapshot().grounded === true);
  return errors;
}

/** 點「點擊開始」並等待 Pointer Lock 生效。 */
export async function startPlaying(page: Page, timeout = 5_000): Promise<void> {
  await page.getByRole('button', { name: '點擊開始' }).click();
  await expect.poll(() => snapshot(page).then((s) => s.pointerLocked), { timeout }).toBe(true);
}

export function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => window.__frontline!.snapshot());
}

/** 把玩家放到指定位置與朝向，並等它站穩。 */
export async function teleport(page: Page, x: number, y: number, z: number, yaw = 0): Promise<void> {
  await page.evaluate(
    ([px, py, pz, pyaw]) => {
      window.__frontline!.teleport(px, py, pz);
      window.__frontline!.setView(pyaw, 0);
    },
    [x, y, z, yaw] as const,
  );
  await page.waitForFunction(() => window.__frontline?.snapshot().grounded === true);
}

/** 把玩家放到 (x, z) 的地面上（高度由碰撞世界查詢）。 */
export async function teleportToGround(page: Page, x: number, z: number, yaw = 0): Promise<number> {
  const ground = await page.evaluate(([px, pz]) => window.__frontline!.groundHeight(px, pz), [x, z] as const);
  if (ground === null) {
    throw new Error(`(${x}, ${z}) 找不到地面`);
  }
  await teleport(page, x, ground + 0.05, z, yaw);
  return ground;
}

/**
 * 按住按鍵並記錄每個模擬步驟，直到 until 完成。
 * until 可以是等待條件（例如 page.waitForFunction），也可以是固定等待。
 */
export async function whileHolding(page: Page, keys: string[], until: () => Promise<unknown>): Promise<StepSample[]> {
  await page.evaluate(() => window.__frontline!.startRecording());
  for (const key of keys) {
    await page.keyboard.down(key);
  }
  try {
    await until();
  } finally {
    for (const key of [...keys].reverse()) {
      await page.keyboard.up(key);
    }
  }
  return page.evaluate(() => window.__frontline!.stopRecording());
}

/** 按住按鍵，直到經過 seconds 秒的模擬時間（不受渲染 FPS 影響）。 */
export function holdForSimSeconds(page: Page, keys: string[], seconds: number, timeout = 60_000): Promise<StepSample[]> {
  const steps = Math.round(seconds * STEPS_PER_SECOND);
  return whileHolding(page, keys, () =>
    page.waitForFunction((target) => window.__frontline!.recordedStepCount() >= target, steps, { timeout }),
  );
}

/** 等待玩家快照符合條件。predicate 是在頁面內以變數 s（快照）求值的運算式字串。 */
export function waitForPlayer(page: Page, predicate: string, timeout = 30_000): () => Promise<unknown> {
  return () =>
    page.waitForFunction(
      (source) => {
        const s = window.__frontline!.snapshot();
        return new Function('s', `return (${source});`)(s) as boolean;
      },
      predicate,
      { timeout },
    );
}

/** 相鄰兩步之間高度下降的最大值，用來偵測爬坡時的抖動。 */
export function maxHeightDrop(samples: StepSample[]): number {
  let drop = 0;
  for (let i = 1; i < samples.length; i++) {
    drop = Math.max(drop, samples[i - 1]!.y - samples[i]!.y);
  }
  return drop;
}
