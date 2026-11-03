import { getWeapon } from '@frontline/game-config';
import { grayboxCollision, grayboxManifest } from '@frontline/map-schema';
import { MOVEMENT } from '@frontline/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { pelletDirections, shotSeed, spreadDegrees } from './ballistics';
import { CharacterBody, IDLE_INPUT, type CharacterInput } from './CharacterBody';
import { raycastHitbox } from './hitboxes';
import { initPhysics } from './rapier';
import { SimWorld } from './SimWorld';
import { WeaponState } from './WeaponState';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

function makeWorld(): SimWorld {
  return new SimWorld(grayboxManifest(), grayboxCollision(), DT);
}

function run(sim: SimWorld, body: CharacterBody, input: CharacterInput, steps: number, yaw = 0): void {
  for (let i = 0; i < steps; i++) {
    body.step(input, yaw, DT);
    sim.step();
  }
}

const forward: CharacterInput = { ...IDLE_INPUT, move: { forward: 1, right: 0, sprint: false } };

describe('CharacterBody（Node 端 Rapier）', () => {
  it('落地後往前走，速度為走路速度', () => {
    const sim = makeWorld();
    const body = new CharacterBody(sim, { x: 0, y: 0.5, z: 12 });
    run(sim, body, IDLE_INPUT, 30);
    expect(body.isGrounded).toBe(true);
    run(sim, body, forward, 60);
    const s = body.snapshot();
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(MOVEMENT.walkSpeed, 1);
    expect(s.feet.z).toBeLessThan(10);
  });

  it('可以走上樓梯', () => {
    const sim = makeWorld();
    const body = new CharacterBody(sim, { x: -6, y: 0, z: 2 });
    let maxY = 0;
    for (let i = 0; i < 150; i++) {
      run(sim, body, forward, 1);
      maxY = Math.max(maxY, body.position.y);
    }
    expect(maxY).toBeGreaterThan(1.75);
  });

  it('臥倒後在低矮通道內無法站起，離開後恢復站姿', () => {
    const sim = makeWorld();
    const body = new CharacterBody(sim, { x: 22, y: 0, z: -4 });
    run(sim, body, { ...IDLE_INPUT, stance: 'prone' }, 10);
    expect(body.currentStance).toBe('prone');
    run(sim, body, { ...IDLE_INPUT, stance: 'standing' }, 10);
    expect(body.currentStance).toBe('crouching');
    run(sim, body, { ...IDLE_INPUT, stance: 'standing', move: { forward: -1, right: 0, sprint: false } }, 300);
    expect(body.currentStance).toBe('standing');
  });

  it('狀態可以存取還原，重播得到相同結果（預測修正的前提）', () => {
    const sim = makeWorld();
    const body = new CharacterBody(sim, { x: 0, y: 0, z: 12 });
    run(sim, body, IDLE_INPUT, 20);
    const saved = body.getState();
    const inputs: CharacterInput[] = Array.from({ length: 40 }, (_, i) => ({
      ...IDLE_INPUT,
      move: { forward: 1, right: i % 10 < 5 ? 1 : 0, sprint: i > 20 },
      jump: i === 10,
    }));
    for (const input of inputs) {
      body.step(input, 0.3, DT);
      sim.step();
    }
    const first = body.getState();
    body.setState(saved);
    for (const input of inputs) {
      body.step(input, 0.3, DT);
      sim.step();
    }
    const second = body.getState();
    expect(second.feet.x).toBeCloseTo(first.feet.x, 4);
    expect(second.feet.y).toBeCloseTo(first.feet.y, 4);
    expect(second.feet.z).toBeCloseTo(first.feet.z, 4);
  });
});

describe('SimWorld 射線', () => {
  it('子彈打到牆、視線被遮擋', () => {
    const sim = makeWorld();
    const hit = sim.castBullet({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: -1 }, 200);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeGreaterThan(5);
    expect(sim.lineOfSight({ x: 0, y: 1.5, z: 10 }, { x: 0, y: 1.5, z: 5 })).toBe(true);
    expect(sim.lineOfSight({ x: 0, y: 0.5, z: -18 }, { x: 0, y: 0.5, z: -22 })).toBe(false);
    expect(sim.groundHeight(0, 10)).toBeCloseTo(0, 3);
  });
});

describe('hitboxes', () => {
  const pose = { feet: { x: 0, y: 0, z: 0 }, yaw: 0, stance: 'standing' as const };

  it('依高度判定頭、軀幹、腿', () => {
    const from = (y: number) => raycastHitbox(pose, { x: 0, y, z: 10 }, { x: 0, y: 0, z: -1 }, 100);
    expect(from(1.64)?.zone).toBe('head');
    expect(from(1.2)?.zone).toBe('torso');
    expect(from(0.5)?.zone).toBe('limb');
    expect(from(2.2)).toBeNull();
    expect(from(1.2)?.distance).toBeCloseTo(10 - 0.22, 2);
  });

  it('射偏或超出距離不算命中', () => {
    expect(raycastHitbox(pose, { x: 1, y: 1.2, z: 10 }, { x: 0, y: 0, z: -1 }, 100)).toBeNull();
    expect(raycastHitbox(pose, { x: 0, y: 1.2, z: 10 }, { x: 0, y: 0, z: -1 }, 5)).toBeNull();
  });

  it('臥倒時站姿高度的射線打不到', () => {
    expect(raycastHitbox({ ...pose, stance: 'prone' }, { x: 0, y: 1.2, z: 10 }, { x: 0, y: 0, z: -1 }, 100)).toBeNull();
    expect(raycastHitbox({ ...pose, stance: 'prone' }, { x: 0, y: 0.22, z: 10 }, { x: 0, y: 0, z: -1 }, 100)).not.toBeNull();
  });
});

describe('ballistics', () => {
  it('同一個種子得到相同的彈丸方向', () => {
    const sg = getWeapon('sg_pump');
    const seed = shotSeed(123, 4, 0, 7);
    const a = pelletDirections(sg, { x: 0, y: 0, z: -1 }, 4, seed);
    const b = pelletDirections(sg, { x: 0, y: 0, z: -1 }, 4, seed);
    expect(a).toHaveLength(9);
    expect(a).toEqual(b);
    expect(shotSeed(123, 4, 0, 8)).not.toBe(seed);
  });

  it('瞄準、蹲下降低散佈，移動與空中增加', () => {
    const ar = getWeapon('ar_carbine');
    const base = { aiming: false, stance: 'standing' as const, moving: false, airborne: false, bloom: 0 };
    expect(spreadDegrees(ar, { ...base, aiming: true })).toBeLessThan(spreadDegrees(ar, base));
    expect(spreadDegrees(ar, { ...base, stance: 'crouching' })).toBeLessThan(spreadDegrees(ar, base));
    expect(spreadDegrees(ar, { ...base, moving: true })).toBeGreaterThan(spreadDegrees(ar, base));
    expect(spreadDegrees(ar, { ...base, airborne: true })).toBeGreaterThan(spreadDegrees(ar, { ...base, moving: true }));
  });
});

describe('WeaponState', () => {
  const held = { trigger: true, reload: false, cycleFireMode: false };
  const idle = { trigger: false, reload: false, cycleFireMode: false };

  function simulate(weapon: WeaponState, seconds: number, input: typeof held, start = 1, dt = 1 / 30) {
    const events = [];
    let t = start;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      t += dt;
      events.push(...weapon.update(t, dt, input));
    }
    return { events, t };
  }

  it('全自動依射速開火，彈匣打空後自動換彈', () => {
    const w = new WeaponState('ar_carbine');
    w.equip(0);
    const { events } = simulate(w, 1, held);
    const shots = events.filter((e) => e.type === 'shot');
    // 750 RPM = 12.5 發／秒
    expect(shots.length).toBeGreaterThanOrEqual(12);
    expect(shots.length).toBeLessThanOrEqual(13);
    expect(w.ammo).toBe(30 - shots.length);
    simulate(w, 2, held, 2);
    expect(events.length).toBeGreaterThan(0);
    expect(w.reloading || w.ammo === 30).toBe(true);
  });

  it('單發模式按住只開一槍；切槍時已按住的扳機不算新的一下', () => {
    const w = new WeaponState('pt_sidearm');
    w.equip(0);
    expect(simulate(w, 1, held).events.filter((e) => e.type === 'shot')).toHaveLength(0);
    w.update(2.1, 1 / 30, idle);
    const { events } = simulate(w, 1, held, 2.1);
    expect(events.filter((e) => e.type === 'shot')).toHaveLength(1);
  });

  it('切換到點放模式後一次三發', () => {
    const w = new WeaponState('ar_carbine');
    w.equip(0);
    w.update(1, 1 / 30, { ...idle, cycleFireMode: true });
    expect(w.fireMode).toBe('burst');
    const { events } = simulate(w, 1, held, 1.1);
    expect(events.filter((e) => e.type === 'shot')).toHaveLength(3);
  });

  it('換彈時間到才補滿，備彈相應減少', () => {
    const w = new WeaponState('ar_carbine');
    w.equip(0);
    simulate(w, 0.5, held);
    const ammoBefore = w.ammo;
    w.update(2, 1 / 30, { ...idle, reload: true });
    expect(w.reloading).toBe(true);
    w.update(2 + w.def.reloadSeconds - 0.1, 1 / 30, idle);
    expect(w.ammo).toBe(ammoBefore);
    w.update(2 + w.def.reloadSeconds + 0.05, 1 / 30, idle);
    expect(w.ammo).toBe(30);
    expect(w.reserve).toBe(120 - (30 - ammoBefore));
  });

  it('泵動霰彈槍逐發裝填，開火可以打斷', () => {
    const w = new WeaponState('sg_pump');
    w.equip(0);
    simulate(w, 2, held);
    w.update(10, 1 / 30, idle);
    w.ammo = 3;
    w.update(10.1, 1 / 30, { ...idle, reload: true });
    w.update(10.1 + 0.56, 1 / 30, idle);
    expect(w.ammo).toBe(4);
    const events = w.update(10.8, 1 / 30, held);
    expect(events.some((e) => e.type === 'shot')).toBe(true);
    expect(w.reloading).toBe(false);
  });

  it('裝備時間內不能開火', () => {
    const w = new WeaponState('ar_carbine');
    w.equip(5);
    expect(w.update(5.2, 1 / 30, held).some((e) => e.type === 'shot')).toBe(false);
    expect(w.update(5.7, 1 / 30, held).some((e) => e.type === 'shot')).toBe(true);
  });
});
