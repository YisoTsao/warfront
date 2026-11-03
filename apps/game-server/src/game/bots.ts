import { BUTTON, eyeHeight, type InputFrame, type Vec3 } from '@frontline/shared';
import type { Match } from './Match';
import type { ServerPlayer } from './ServerPlayer';

const THINK_INTERVAL = 0.25;
const MAX_TURN_RATE = 5; // 弧度／秒
const ENGAGE_RANGE = 90;

/**
 * 伺服器端 bot：產生與真人相同格式的輸入框，經過同一套權威規則（移動、武器、命中）。
 * 行為：找視線內最近的敵人、反應延遲後瞄準射擊並左右移動；沒有目標時前往據點或敵方區域；
 * 卡住時跳躍並繞路；醫療兵會救援附近倒地的隊友。
 */
export class BotBrain {
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private target: number | null = null;
  private targetSince = 0;
  private nextThink = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private stuckTime = 0;
  private detourUntil = 0;
  private detourYaw = 0;
  private goal: Vec3 | null = null;
  private goalUntil = 0;
  private crouch = false;
  private aimError = { yaw: 0, pitch: 0 };

  constructor(
    readonly number: number,
    private readonly random: () => number,
  ) {}

  think(match: Match, bot: ServerPlayer, now: number): InputFrame | null {
    this.seq++;
    const frame: InputFrame = { s: this.seq, f: 0, r: 0, b: 0, st: 0, y: this.yaw, p: this.pitch, w: 0, vt: match.tick };
    if (!bot.spawned) {
      bot.deployRequested = true;
      return frame;
    }
    if (bot.health.state === 'downed') {
      // 沒有醫療兵靠近就在一段時間後放棄
      if (now - bot.health.bleedoutEnd + bot.health.config.bleedoutSeconds > 8) {
        frame.b |= BUTTON.giveUp;
      }
      return frame;
    }
    const body = bot.body!;
    const feet = body.position;
    const eye = { x: feet.x, y: feet.y + eyeHeight(body.currentStance), z: feet.z };
    const dt = 1 / 30;

    if (now >= this.nextThink) {
      this.nextThink = now + THINK_INTERVAL;
      this.chooseTarget(match, bot, eye, now);
    }
    const target = this.target !== null ? match.players.get(this.target) : undefined;
    const weapon = bot.currentWeapon;

    let desiredYaw: number;
    let desiredPitch: number;
    if (target?.spawned) {
      const chest = { x: target.body!.position.x, y: target.body!.position.y + (target.body!.currentStance === 'prone' ? 0.25 : target.body!.currentStance === 'crouching' ? 0.75 : 1.2), z: target.body!.position.z };
      const d = { x: chest.x - eye.x, y: chest.y - eye.y, z: chest.z - eye.z };
      const horizontal = Math.hypot(d.x, d.z);
      desiredYaw = Math.atan2(-d.x, -d.z) + this.aimError.yaw;
      desiredPitch = Math.atan2(d.y, horizontal) + this.aimError.pitch;
      // 瞄準誤差隨時間收斂（反應與修正）
      this.aimError.yaw *= 0.9;
      this.aimError.pitch *= 0.9;
      // 交戰時左右移動
      if (now >= this.strafeUntil) {
        this.strafe = this.random() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 0.6 + this.random() * 0.8;
        this.crouch = horizontal > 25 && this.random() < 0.3;
      }
      frame.r = this.strafe;
      frame.st = this.crouch ? 1 : 0;
      if (horizontal > 15) {
        frame.b |= BUTTON.aim;
      }
      const error = Math.abs(Math.atan2(Math.sin(desiredYaw - this.yaw), Math.cos(desiredYaw - this.yaw))) + Math.abs(desiredPitch - this.pitch);
      const reacted = now - this.targetSince > 0.35;
      if (reacted && error < 0.05 + 1.5 / Math.max(5, horizontal) && weapon && weapon.ammo > 0) {
        // 單發武器需要放開再按
        if (weapon.fireMode === 'auto' || this.seq % 4 < 2) {
          frame.b |= BUTTON.fire;
        }
      }
      if (bot.grenades > 0 && horizontal > 12 && horizontal < 28 && this.random() < 0.004) {
        frame.b |= BUTTON.grenade;
        desiredPitch += 0.3;
      }
      if (bot.classDef.ability.kind === 'spot' && now >= bot.abilityReadyAt) {
        frame.b |= BUTTON.ability;
      }
    } else {
      this.target = null;
      this.navigate(match, bot, feet, now, frame);
      desiredYaw = this.detourUntil > now ? this.detourYaw : this.goalYaw(feet);
      desiredPitch = 0;
      frame.st = 0;
      if (weapon && weapon.ammo < weapon.def.magazineSize * 0.4 && !weapon.reloading) {
        frame.b |= BUTTON.reload;
      }
      const ability = bot.classDef.ability.kind;
      if (now >= bot.abilityReadyAt && ((ability === 'stim' && bot.health.health < 60) || ability === 'healPulse' || ability === 'resupply')) {
        frame.b |= BUTTON.ability;
      }
    }
    if (weapon && weapon.ammo === 0 && !weapon.reloading) {
      frame.b |= BUTTON.reload;
    }

    // 轉向速度限制
    const yawDelta = Math.atan2(Math.sin(desiredYaw - this.yaw), Math.cos(desiredYaw - this.yaw));
    this.yaw += Math.max(-MAX_TURN_RATE * dt, Math.min(MAX_TURN_RATE * dt, yawDelta));
    this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    this.pitch += Math.max(-MAX_TURN_RATE * dt, Math.min(MAX_TURN_RATE * dt, desiredPitch - this.pitch));
    frame.y = this.yaw;
    frame.p = this.pitch;

    // 卡住偵測：想移動但速度很低
    const wantsMove = frame.f !== 0 || frame.r !== 0;
    const speed = Math.hypot(body.snapshot().velocity.x, body.snapshot().velocity.z);
    this.stuckTime = wantsMove && speed < 0.4 ? this.stuckTime + dt : 0;
    if (this.stuckTime > 0.8) {
      frame.b |= BUTTON.jump;
      this.detourYaw = this.yaw + (this.random() < 0.5 ? -1 : 1) * (1 + this.random() * 0.8);
      this.detourUntil = now + 1.2;
      this.stuckTime = 0;
    }
    return frame;
  }

  private chooseTarget(match: Match, bot: ServerPlayer, eye: Vec3, now: number): void {
    let best: { number: number; distance: number } | null = null;
    for (const enemy of match.players.values()) {
      if (enemy.team === bot.team || !enemy.spawned || enemy.health.state === 'downed') {
        continue;
      }
      const p = enemy.body!.position;
      const chest = { x: p.x, y: p.y + 1.1, z: p.z };
      const distance = Math.hypot(chest.x - eye.x, chest.z - eye.z);
      if (distance > ENGAGE_RANGE || (best && distance >= best.distance)) {
        continue;
      }
      // 視野：前方 150 度內，或很近、或被標定
      const angle = Math.abs(Math.atan2(Math.sin(Math.atan2(-(chest.x - eye.x), -(chest.z - eye.z)) - this.yaw), Math.cos(Math.atan2(-(chest.x - eye.x), -(chest.z - eye.z)) - this.yaw)));
      if (angle > 1.3 && distance > 12 && enemy.spottedUntil <= now) {
        continue;
      }
      if (!match.sim.lineOfSight(eye, chest)) {
        continue;
      }
      best = { number: enemy.number, distance };
    }
    if (best?.number !== this.target) {
      this.target = best?.number ?? null;
      this.targetSince = now;
      this.aimError = { yaw: (this.random() - 0.5) * 0.25, pitch: (this.random() - 0.5) * 0.12 };
    }
  }

  private navigate(match: Match, bot: ServerPlayer, feet: Vec3, now: number, frame: InputFrame): void {
    // 醫療兵：前往附近倒地的隊友並按住互動
    const downed = [...match.players.values()].find(
      (p) => p.team === bot.team && p.health.state === 'downed' && p.body && Math.hypot(p.body.position.x - feet.x, p.body.position.z - feet.z) < 20,
    );
    if (downed && bot.classDef.id === 'medic') {
      this.goal = { ...downed.body!.position };
      this.goalUntil = now + 1;
      if (Math.hypot(this.goal.x - feet.x, this.goal.z - feet.z) < 1.8) {
        frame.b |= BUTTON.interact;
        return;
      }
    }
    if (!this.goal || now >= this.goalUntil || Math.hypot(this.goal.x - feet.x, this.goal.z - feet.z) < 4) {
      this.goal = this.pickGoal(match, bot, feet);
      this.goalUntil = now + 20 + this.random() * 10;
    }
    const distance = Math.hypot(this.goal.x - feet.x, this.goal.z - feet.z);
    frame.f = 1;
    if (distance > 20) {
      frame.b |= BUTTON.sprint;
    }
  }

  private pickGoal(match: Match, bot: ServerPlayer, feet: Vec3): Vec3 {
    const objectives = match.mode.objectives();
    if (objectives.length > 0) {
      const wanted = objectives.filter((o) => o.owner !== bot.team || o.contested);
      const pool = wanted.length > 0 ? wanted : objectives;
      const sorted = [...pool].sort((a, b) => Math.hypot(a.position[0] - feet.x, a.position[2] - feet.z) - Math.hypot(b.position[0] - feet.x, b.position[2] - feet.z));
      const pick = sorted[this.random() < 0.7 ? 0 : Math.floor(this.random() * sorted.length)]!;
      const angle = this.random() * Math.PI * 2;
      const r = pick.radius * 0.5 * this.random();
      return { x: pick.position[0] + Math.cos(angle) * r, y: pick.position[1], z: pick.position[2] + Math.sin(angle) * r };
    }
    // 團隊死鬥：往敵方出生區方向、在地圖中段隨機遊走
    const enemySpawns = match.manifest.spawns.filter((s) => s.team && s.team !== bot.team);
    const anchor = enemySpawns[Math.floor(this.random() * enemySpawns.length)] ?? match.manifest.spawns[0]!;
    const t = 0.35 + this.random() * 0.4;
    return {
      x: feet.x + (anchor.position[0] - feet.x) * t + (this.random() - 0.5) * 30,
      y: feet.y,
      z: feet.z + (anchor.position[2] - feet.z) * t + (this.random() - 0.5) * 30,
    };
  }

  private goalYaw(feet: Vec3): number {
    if (!this.goal) {
      return this.yaw;
    }
    return Math.atan2(-(this.goal.x - feet.x), -(this.goal.z - feet.z));
  }
}
