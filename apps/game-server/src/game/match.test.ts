import { BUTTON, TICK_RATE, type InputFrame } from '@frontline/shared';
import { initPhysics, loadMapData, type LoadedMapData } from '@frontline/simulation';
import { beforeAll, describe, expect, it } from 'vitest';
import { Match, type MatchResult } from './Match';
import type { ServerPlayer } from './ServerPlayer';

let graybox: LoadedMapData;

beforeAll(async () => {
  await initPhysics();
  graybox = await loadMapData('graybox', '', async () => ({}));
});

function createMatch(options: Partial<ConstructorParameters<typeof Match>[0]> = {}): Match {
  return new Match({ map: graybox, mode: 'tdm', botFill: 0, seed: 1234, warmupSeconds: 0, ...options });
}

function join(match: Match, name: string, team?: 'alpha' | 'bravo'): ServerPlayer {
  const player = match.addPlayer({ guestId: name, name, sessionId: name, ...(team ? { team } : {}) });
  match.deploy(player.number, 'base');
  return player;
}

class Driver {
  seq = 0;
  constructor(
    readonly match: Match,
    readonly player: ServerPlayer,
  ) {}
  frame(partial: Partial<InputFrame> = {}): InputFrame {
    this.seq++;
    return { s: this.seq, f: 0, r: 0, b: 0, st: 0, y: 0, p: 0, w: 0, vt: this.match.tick, ...partial };
  }
  send(partial: Partial<InputFrame> = {}): void {
    this.match.pushInput(this.player.number, this.frame(partial));
  }
}

function run(match: Match, ticks: number, each?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    each?.();
    match.step();
  }
}

/** 把玩家放到指定位置（測試設定場景用；遊戲中只能經由輸入移動）。 */
function place(player: ServerPlayer, x: number, z: number): void {
  player.body!.teleport({ x, y: 0.05, z });
}

/** 從 a 看向 b 胸口的 yaw / pitch */
function aimAt(a: ServerPlayer, b: ServerPlayer): { y: number; p: number } {
  const from = { x: a.body!.position.x, y: a.body!.position.y + 1.64, z: a.body!.position.z };
  const to = { x: b.body!.position.x, y: b.body!.position.y + 1.2, z: b.body!.position.z };
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return { y: Math.atan2(-dx, -dz), p: Math.atan2(to.y - from.y, Math.hypot(dx, dz)) };
}

describe('Match：加入、分隊與出生', () => {
  it('依人數分隊，部署後在己方出生點出生', () => {
    const match = createMatch();
    const a = join(match, 'a');
    const b = join(match, 'b');
    expect(a.team).not.toBe(b.team);
    run(match, 2);
    expect(a.spawned && b.spawned).toBe(true);
    expect(a.team === 'alpha' ? a.body!.position.z : b.body!.position.z).toBeGreaterThan(40);
  });

  it('bot 補滿到指定人數，真人加入時讓出位置', () => {
    const match = createMatch({ botFill: 8 });
    join(match, 'human');
    expect(match.players.size).toBe(8);
    expect([...match.players.values()].filter((p) => p.bot)).toHaveLength(7);
    const counts = match.teamCounts();
    expect(Math.abs(counts.alpha - counts.bravo)).toBeLessThanOrEqual(1);
    join(match, 'human2');
    expect(match.players.size).toBe(8);
  });

  it('16 人上限：滿員時不再加入 bot', () => {
    const match = createMatch({ botFill: 32 });
    expect(match.players.size).toBe(16);
    expect(match.teamCounts()).toEqual({ alpha: 8, bravo: 8 });
  });
});

describe('Match：權威移動與輸入驗證', () => {
  it('只能經由輸入移動，速度不超過衝刺速度', () => {
    const match = createMatch();
    const a = join(match, 'a');
    run(match, 2);
    const start = { ...a.body!.position };
    const d = new Driver(match, a);
    run(match, TICK_RATE, () => d.send({ f: 1, b: BUTTON.sprint }));
    const moved = Math.hypot(a.body!.position.x - start.x, a.body!.position.z - start.z);
    expect(moved).toBeGreaterThan(3);
    expect(moved).toBeLessThanOrEqual(6.05);
  });

  it('重複、過舊或含 NaN 的輸入框被拒絕', () => {
    const match = createMatch();
    const a = join(match, 'a');
    run(match, 2);
    const d = new Driver(match, a);
    expect(match.pushInput(a.number, d.frame())).toBe(true);
    expect(match.pushInput(a.number, { ...d.frame(), s: 1 })).toBe(false);
    expect(match.pushInput(a.number, { ...d.frame(), y: Number.NaN })).toBe(false);
    expect(match.counters.rejectedInputs).toBe(2);
  });

  it('pitch 被夾在 ±89°、軸向被夾在 -1–1', () => {
    const match = createMatch();
    const a = join(match, 'a');
    run(match, 2);
    match.pushInput(a.number, { s: 1, f: 5, r: -7, b: 0, st: 9, y: 0, p: 10, w: 3, vt: 0 });
    match.step();
    expect(a.lastFrame!.f).toBe(1);
    expect(a.lastFrame!.r).toBe(-1);
    expect(a.lastFrame!.st).toBe(2);
    expect(a.lastFrame!.p).toBeCloseTo((89 * Math.PI) / 180);
    expect(a.lastFrame!.w).toBe(0);
  });
});

describe('Match：開火、命中與計分', () => {
  function duel() {
    const match = createMatch({ modeOverrides: { scoreLimit: 2 } });
    const a = join(match, 'a', 'alpha');
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    place(a, 0, 20);
    place(b, 0, 10);
    // 出生後武器需要 0.6 秒舉槍
    run(match, TICK_RATE);
    return { match, a, b, da: new Driver(match, a) };
  }

  it('射速由伺服器限制：按住扳機 1 秒約 12–13 發', () => {
    const { match, a, da } = duel();
    const aim = { y: Math.PI / 2, p: -0.2 };
    const before = a.currentWeapon!.ammo;
    run(match, TICK_RATE, () => da.send({ b: BUTTON.fire, ...aim }));
    const shots = before - a.currentWeapon!.ammo;
    expect(shots).toBeGreaterThanOrEqual(11);
    expect(shots).toBeLessThanOrEqual(13);
  });

  it('瞄準敵人開火會造成傷害並回報命中；打偏不會', () => {
    const { match, a, b, da } = duel();
    const aim = aimAt(a, b);
    run(match, 3, () => da.send({ b: BUTTON.fire | BUTTON.aim, ...aim }));
    const events = match.drainEvents();
    expect(b.health.health).toBeLessThan(100);
    expect(events.private.get(a.number)?.some((e) => e.k === 'hit')).toBe(true);
    expect(events.private.get(b.number)?.some((e) => e.k === 'damaged')).toBe(true);
    expect(events.broadcast.some((e) => e.k === 'shot')).toBe(true);

    const health = b.health.health;
    run(match, 3, () => da.send({ b: BUTTON.fire | BUTTON.aim, y: aim.y + 0.5, p: aim.p }));
    expect(b.health.health).toBe(health);
  });

  it('擊殺：計分、擊殺訊息、死亡後依重生時間重新部署', () => {
    const { match, a, b, da } = duel();
    const aim = aimAt(a, b);
    run(match, TICK_RATE * 2, () => da.send({ b: BUTTON.fire | BUTTON.aim, ...aim }));
    expect(b.spawned).toBe(false);
    expect(a.stats.kills).toBe(1);
    expect(b.stats.deaths).toBe(1);
    expect(match.mode.scores().alpha).toBe(1);
    match.deploy(b.number, 'base');
    run(match, TICK_RATE * 6);
    expect(b.spawned).toBe(true);
  });

  it('友傷預設關閉：打隊友沒有傷害', () => {
    const match = createMatch();
    const a = join(match, 'a', 'alpha');
    const c = join(match, 'c', 'alpha');
    run(match, 2);
    place(a, 0, 20);
    place(c, 0, 10);
    run(match, TICK_RATE);
    const d = new Driver(match, a);
    const aim = aimAt(a, c);
    run(match, 10, () => d.send({ b: BUTTON.fire | BUTTON.aim, ...aim }));
    expect(c.health.health).toBe(100);
  });

  it('達到分數上限時結束對戰並回報結果，之後自動開始新一場', () => {
    const results: MatchResult[] = [];
    const match = createMatch({ modeOverrides: { scoreLimit: 1 }, resultSeconds: 5, onMatchEnd: (r) => results.push(r) });
    const a = join(match, 'a', 'alpha');
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    place(a, 0, 20);
    place(b, 0, 10);
    run(match, TICK_RATE);
    const d = new Driver(match, a);
    const aim = aimAt(a, b);
    run(match, TICK_RATE * 2, () => d.send({ b: BUTTON.fire | BUTTON.aim, ...aim }));
    expect(match.phase).toBe('ended');
    expect(results[0]?.winner).toBe('alpha');
    expect(results[0]?.players.find((p) => p.name === 'a')?.kills).toBe(1);
    run(match, TICK_RATE * 6);
    expect(match.phase).not.toBe('ended');
    expect(match.mode.scores()).toEqual({ alpha: 0, bravo: 0 });
  });
});

describe('Match：延遲補償', () => {
  it('依客戶端畫面上的 tick 回溯目標位置判定命中', () => {
    const match = createMatch();
    const a = join(match, 'a', 'alpha');
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    place(a, 0, 20);
    place(b, 0, 10);
    run(match, TICK_RATE);
    const viewTick = match.tick;
    const aim = aimAt(a, b);
    // 目標往側邊移動 3 步（不到最大回溯時間）
    const db = new Driver(match, b);
    run(match, 3, () => db.send({ r: 1, b: BUTTON.sprint }));
    place(b, 1.5, 10);
    run(match, 1);
    const da = new Driver(match, a);
    // 以舊畫面（目標仍在原位）開火：仍然命中
    da.send({ b: BUTTON.fire | BUTTON.aim, ...aim, vt: viewTick });
    match.step();
    expect(b.health.health).toBeLessThan(100);
  });
});

describe('Match：征服模式', () => {
  it('站在據點內會佔領，擁有多數據點時對方流失票數，死亡扣票', () => {
    const match = createMatch({ mode: 'conquest', modeOverrides: { captureSeconds: 1, bleedPerSecond: 2 } });
    const a = join(match, 'a', 'alpha');
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    const objective = match.manifest.objectives[0]!;
    place(a, objective.position[0], objective.position[2]);
    run(match, TICK_RATE * 2);
    expect(match.mode.objectives()[0]!.owner).toBe('alpha');
    expect(a.stats.captures).toBe(1);
    const before = match.mode.scores().bravo;
    run(match, TICK_RATE);
    expect(match.mode.scores().bravo).toBeLessThan(before);
    void b;
  });

  it('兩隊都在據點內時為爭奪中，進度不變', () => {
    const match = createMatch({ mode: 'conquest', modeOverrides: { captureSeconds: 1 } });
    const a = join(match, 'a', 'alpha');
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    const o = match.manifest.objectives[1]!;
    place(a, o.position[0] + 1, o.position[2]);
    place(b, o.position[0] - 1, o.position[2]);
    run(match, TICK_RATE);
    const state = match.mode.objectives()[1]!;
    expect(state.contested).toBe(true);
    expect(state.progress).toBe(0);
  });

  it('倒地後可被隊友救起；未救援則流血死亡並扣票', () => {
    const match = createMatch({ mode: 'conquest' });
    const a = join(match, 'a', 'alpha');
    const medic = join(match, 'm', 'alpha');
    medic.setLoadout({ classId: 'medic' });
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    place(a, 0, 20);
    place(medic, 1, 20);
    place(b, 0, 10);
    run(match, 2);
    match.applyDamage(a, 150, b, '測試', 'torso', b.body!.position);
    expect(a.health.state).toBe('downed');
    expect(b.stats.kills).toBe(1);
    const dm = new Driver(match, medic);
    run(match, TICK_RATE * 6, () => dm.send({ b: BUTTON.interact }));
    expect(a.health.state).toBe('alive');
    expect(medic.stats.revives).toBe(1);

    const tickets = match.mode.scores().alpha;
    match.applyDamage(a, 150, b, '測試', 'torso', b.body!.position);
    run(match, TICK_RATE * 25);
    expect(a.health.state).toBe('dead');
    expect(match.mode.scores().alpha).toBeLessThan(tickets);
  });
});

describe('Match：手榴彈、禁區與地圖邊界', () => {
  it('手榴彈爆炸對範圍內的敵人造成傷害', () => {
    const match = createMatch();
    const a = join(match, 'a', 'alpha');
    const b = join(match, 'b', 'bravo');
    run(match, 2);
    place(a, 0, 20);
    // 以約 18° 仰角投出，落點約在 13–16 m 外
    place(b, 0, 6);
    run(match, 2);
    const d = new Driver(match, a);
    d.send({ b: BUTTON.grenade, y: 0, p: 0.2 });
    run(match, Math.ceil(TICK_RATE * 4));
    expect(b.health.health).toBeLessThan(100);
    expect(match.drainEvents().broadcast.some((e) => e.k === 'explosion')).toBe(true);
  });

  it('離開地圖範圍超過寬限時間會死亡', () => {
    const match = createMatch();
    const a = join(match, 'a');
    run(match, 2);
    a.body!.teleport({ x: 0, y: 0.05, z: 0 });
    // 地圖範圍是 ±60，放到範圍外的平台需要真實地面，這裡直接檢查邊界判定：外牆外的位置
    a.body!.teleport({ x: 59.5, y: 0.05, z: 0 });
    run(match, 2);
    expect(a.restrictedTime).toBe(0);
    a.body!.teleport({ x: 61, y: 5, z: 0 });
    run(match, TICK_RATE * 6);
    expect(a.health.state === 'dead' || a.stats.deaths > 0).toBe(true);
  });
});

describe('Match：bot', () => {
  it('bot 會出生、移動，並在對戰中交火', () => {
    const match = createMatch({ botFill: 8 });
    run(match, TICK_RATE * 40);
    const bots = [...match.players.values()].filter((p) => p.bot);
    expect(bots.every((b) => b.body !== null)).toBe(true);
    expect(match.counters.shots).toBeGreaterThan(0);
    expect(match.counters.hits).toBeGreaterThan(0);
  });
});
