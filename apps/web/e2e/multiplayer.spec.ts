import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Phase 4–8：多人連線（需要對戰伺服器，playwright.config 會自動啟動，並啟用 DEV_COMMANDS 方便擺放玩家）。
 * 主規格 §6.2 的垂直切片：兩個瀏覽器加入同一場、看到彼此、開火、伺服器判定傷害、雙方看到一致的結果。
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

type Net = Record<string, unknown> & {
  playerNumber: number;
  team: 'alpha' | 'bravo';
  life: string;
  remotes: number;
  remotePositions: Array<{ number: number; team: string; x: number; z: number; alive: boolean }>;
  connection: string;
  phase: string | null;
};

const pages: Page[] = [];

test.afterEach(async () => {
  for (const page of pages.splice(0)) {
    await page.evaluate(() => window.__frontline?.leave?.()).catch(() => undefined);
    await page.context().close().catch(() => undefined);
  }
});

async function joinMatch(browser: Browser, options: { name: string; mode?: string; map?: string; bots?: number; scoreLimit?: number }): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  pages.push(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const guest = `pw-${Math.random().toString(36).slice(2, 12)}`;
  const params = new URLSearchParams({
    debug: '1',
    match: options.mode ?? 'tdm',
    matchMap: options.map ?? 'graybox',
    bots: String(options.bots ?? 0),
    guest,
    name: options.name,
    ...(options.scoreLimit ? { scoreLimit: String(options.scoreLimit) } : {}),
  });
  await page.goto(`/?${params.toString()}`);
  await expect(page.getByTestId('deploy-screen')).toBeVisible({ timeout: 60_000 });
  return { page, errors };
}

const net = (page: Page): Promise<Net> => page.evaluate(() => window.__frontline!.net!() as Net);
const hud = (page: Page) => page.evaluate(() => window.__frontline!.hud());

async function deploy(page: Page, classLabel?: string, primary?: string): Promise<void> {
  if (classLabel) {
    await page.getByRole('radio', { name: new RegExp(classLabel) }).click();
  }
  if (primary) {
    await page.getByLabel('主武器').selectOption(primary);
  }
  await page.getByRole('button', { name: /^部署/ }).click();
  await expect.poll(() => net(page).then((n) => n.life), { timeout: 30_000 }).toBe('alive');
}

async function mouse(page: Page, button: 0 | 2, down: boolean): Promise<void> {
  await page.evaluate(([b, d]) => document.dispatchEvent(new MouseEvent(d ? 'mousedown' : 'mouseup', { button: b })), [button, down] as const);
}

/** 用開發指令把玩家放到固定位置，等本機預測與伺服器一致。 */
async function placeAt(page: Page, x: number, z: number, yaw: number): Promise<void> {
  await page.evaluate(([px, pz, pyaw]) => {
    window.__frontline!.devTeleport!(px, 0.05, pz);
    window.__frontline!.setView(pyaw, 0);
  }, [x, z, yaw] as const);
  await expect.poll(() => page.evaluate(() => window.__frontline!.snapshot().feet), { timeout: 15_000 }).toMatchObject({ x: expect.closeTo(x, 0), z: expect.closeTo(z, 0) });
}

test('兩個瀏覽器加入同一場、看到彼此移動、開火由伺服器判定並同步結果', async ({ browser }) => {
  const a = await joinMatch(browser, { name: '甲' });
  const b = await joinMatch(browser, { name: '乙' });
  await deploy(a.page);
  await deploy(b.page);
  const na = await net(a.page);
  const nb = await net(b.page);
  expect(na.team).not.toBe(nb.team);
  await expect.poll(() => net(a.page).then((n) => n.remotes)).toBe(1);

  await placeAt(a.page, 0, 20, 0);
  await placeAt(b.page, 0, 8, Math.PI);

  // 乙往前走，甲看到的位置跟著改變（插值後與乙自己的位置一致）
  await b.page.keyboard.down('KeyD');
  await b.page.waitForTimeout(1200);
  await b.page.keyboard.up('KeyD');
  const bFeet = await b.page.evaluate(() => window.__frontline!.snapshot().feet);
  await expect
    .poll(async () => {
      const seen = (await net(a.page)).remotePositions.find((r) => r.number === nb.playerNumber);
      return seen ? Math.hypot(seen.x - bFeet.x, seen.z - bFeet.z) : 99;
    }, { timeout: 10_000 })
    .toBeLessThan(0.6);
  expect(Math.abs(bFeet.x)).toBeGreaterThan(0.5);

  // 甲瞄準乙的胸口開火，直到伺服器判定乙陣亡
  await a.page.evaluate((target) => {
    const s = window.__frontline!.snapshot();
    const dx = target.x - s.feet.x;
    const dz = target.z - s.feet.z;
    const dy = target.y + 1.2 - (s.feet.y + 1.64);
    window.__frontline!.setView(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, bFeet);
  await a.page.bringToFront();
  await mouse(a.page, 2, true);
  await a.page.waitForTimeout(500);
  await mouse(a.page, 0, true);
  await expect.poll(() => net(b.page).then((n) => n.life), { timeout: 30_000 }).toBe('dead');
  await mouse(a.page, 0, false);
  await mouse(a.page, 2, false);

  const combat = await a.page.evaluate(() => window.__frontline!.combat());
  expect(combat.hits).toBeGreaterThan(0);
  expect(combat.kills).toBe(1);

  // 雙方的擊殺訊息與計分板一致
  for (const page of [a.page, b.page]) {
    await expect(page.getByLabel('擊殺訊息')).toContainText('甲');
    await expect(page.getByLabel('擊殺訊息')).toContainText('乙');
    await expect
      .poll(async () => {
        const h = await hud(page);
        const killer = h.scoreboard.find((r) => r.name === '甲');
        const victim = h.scoreboard.find((r) => r.name === '乙');
        return { kills: killer?.kills, deaths: victim?.deaths, score: h.teamScores[na.team] };
      })
      .toEqual({ kills: 1, deaths: 1, score: 1 });
  }
  // 乙看到部署畫面，可以重新部署
  await expect(b.page.getByTestId('deploy-screen')).toBeVisible({ timeout: 10_000 });
  expect([...a.errors, ...b.errors]).toEqual([]);
});

test('斷線後自動重連，保留同一個玩家位置', async ({ browser }) => {
  const a = await joinMatch(browser, { name: '重連' });
  await deploy(a.page);
  const before = await net(a.page);
  // SDK 需要房間連線一段時間後才會自動重連
  await a.page.waitForTimeout(6000);
  await a.page.evaluate(() => window.__frontline!.simulateDrop!());
  await expect.poll(() => net(a.page).then((n) => n.connection), { timeout: 10_000 }).toBe('reconnecting');
  await expect.poll(() => net(a.page).then((n) => n.connection), { timeout: 30_000 }).toBe('connected');
  const after = await net(a.page);
  expect(after.playerNumber).toBe(before.playerNumber);
  expect(after.team).toBe(before.team);
  // 斷線期間角色被移出模擬，重連後重新部署
  await expect(a.page.getByTestId('deploy-screen')).toBeVisible({ timeout: 20_000 });
  await deploy(a.page);
});

test('兵種與配裝：選偵察兵與栓動狙擊槍後部署', async ({ browser }) => {
  const a = await joinMatch(browser, { name: '偵察' });
  await deploy(a.page, '偵察兵', 'sr_bolt');
  expect((await a.page.evaluate(() => window.__frontline!.weapon())).id).toBe('sr_bolt');
  await expect.poll(() => hud(a.page).then((h) => h.abilityName)).toBe('標定');
});

test('征服：站在據點內佔領，對方開始流失票數', async ({ browser }) => {
  const a = await joinMatch(browser, { name: '佔領', mode: 'conquest' });
  await deploy(a.page);
  const team = (await net(a.page)).team;
  const enemy = team === 'alpha' ? 'bravo' : 'alpha';
  await placeAt(a.page, -40, 30, 0);
  await expect(a.page.getByLabel('佔領進度')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => hud(a.page).then((h) => h.objectives.find((o) => o.id === 'A')?.owner), { timeout: 30_000 }).toBe(team);
  await expect(a.page.getByTestId('objective-A')).toHaveAttribute('data-owner', team);
  const tickets = (await hud(a.page)).teamScores[enemy];
  await a.page.waitForTimeout(3000);
  expect((await hud(a.page)).teamScores[enemy]).toBeLessThan(tickets);
});

test('伺服器列表顯示進行中的房間', async ({ browser }) => {
  await joinMatch(browser, { name: '列表', bots: 2 });
  const context = await browser.newContext();
  const page = await context.newPage();
  pages.push(page);
  await page.goto('/');
  await page.getByRole('button', { name: '伺服器列表' }).click();
  await expect(page.getByRole('cell', { name: '灰盒測試場' }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '加入' }).first()).toBeEnabled();
});

test('16 人滿房（1 真人 + 15 bot）：伺服器 tick 穩定，bot 交戰', async ({ browser, request }) => {
  const a = await joinMatch(browser, { name: '滿房', bots: 16 });
  await deploy(a.page);
  await expect.poll(() => net(a.page).then((n) => n.remotes), { timeout: 20_000 }).toBe(15);
  await a.page.waitForTimeout(20_000);
  const metrics = (await (await request.get('http://127.0.0.1:2567/metrics')).json()) as {
    rooms: Array<{ humans: number; bots: number; tickMs: { p95: number; max: number } }>;
  };
  const room = metrics.rooms.find((r) => r.humans + r.bots === 16);
  expect(room).toBeDefined();
  // 30 Hz 的 tick 預算是 33 ms
  expect(room!.tickMs.p95).toBeLessThan(33);
  expect((await hud(a.page)).scoreboard).toHaveLength(16);
  // 兩隊出生區相距約 100 m，bot 需要一段時間接近後才會交火
  await expect
    .poll(() => hud(a.page).then((h) => h.scoreboard.reduce((s, r) => s + r.kills + r.deaths, 0)), { timeout: 60_000 })
    .toBeGreaterThan(0);
});

test('團隊死鬥完整流程：達到分數上限 → 結算畫面 → 自動開始下一場', async ({ browser }) => {
  const a = await joinMatch(browser, { name: '流程', bots: 8, scoreLimit: 3 });
  await deploy(a.page);
  await expect(a.page.getByTestId('match-result')).toBeVisible({ timeout: 150_000 });
  const h = await hud(a.page);
  expect(h.winner).not.toBeNull();
  expect(Math.max(h.teamScores.alpha, h.teamScores.bravo)).toBeGreaterThanOrEqual(3);
  // RESULT_SECONDS=6：結算後開始新的一場，分數歸零
  await expect(a.page.getByTestId('match-result')).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => hud(a.page).then((x) => x.teamScores.alpha + x.teamScores.bravo), { timeout: 10_000 }).toBeLessThan(3);
});
