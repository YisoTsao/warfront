import { toggleStance, type Stance, type Vec3 } from '@frontline/shared';
import {
  CharacterBody,
  waterDepthAt,
  waterSpeedScale,
  type CharacterInput,
  type CharacterSnapshot,
  type CharacterState,
  type SimWorld,
} from '@frontline/simulation';
import type { SimulationInput } from '../input/InputManager';

/**
 * 本機玩家：把按鍵事件轉成「想要的姿勢」等角色輸入，推進共用的 CharacterBody，
 * 並保留前後兩個模擬狀態供渲染內插。
 */
export class LocalPlayer {
  readonly body: CharacterBody;
  desiredStance: Stance = 'standing';
  private previousFeet: Vec3;
  private currentFeet: Vec3;
  private pendingLanding = 0;

  constructor(
    private readonly sim: SimWorld,
    spawnFeet: Vec3,
  ) {
    this.body = new CharacterBody(sim, spawnFeet);
    this.previousFeet = { ...spawnFeet };
    this.currentFeet = { ...spawnFeet };
  }

  /**
   * 由按鍵事件產生角色輸入：
   * - C / Z 切換蹲下、臥倒；
   * - 蹲或臥時按跳躍改為起身（與舊版 UE5 相同）；
   * - 蹲下時按住衝刺往前會起身衝刺。
   */
  buildInput(input: SimulationInput, aim: boolean): CharacterInput {
    if (input.pressed.has('crouch')) {
      this.desiredStance = toggleStance(this.desiredStance, 'crouch');
    }
    if (input.pressed.has('prone')) {
      this.desiredStance = toggleStance(this.desiredStance, 'prone');
    }
    let jump = input.pressed.has('jump');
    if (jump && (this.desiredStance !== 'standing' || this.body.currentStance !== 'standing')) {
      this.desiredStance = 'standing';
      jump = false;
    }
    if (input.move.sprint && input.move.forward > 0 && this.desiredStance === 'crouching') {
      this.desiredStance = 'standing';
    }
    return { move: input.move, jump, stance: this.desiredStance, aim };
  }

  step(input: CharacterInput, yaw: number, dt: number): void {
    this.previousFeet = { ...this.currentFeet };
    this.body.speedScale = waterSpeedScale(waterDepthAt(this.sim.manifest, this.body.position));
    const result = this.body.step(input, yaw, dt);
    this.currentFeet = { ...this.body.position };
    if (result.landed > 0) {
      this.pendingLanding = Math.max(this.pendingLanding, result.landed);
    }
  }

  /** 預測修正：直接設定狀態（不產生內插跳動）。 */
  setState(state: CharacterState): void {
    this.body.setState(state);
    this.currentFeet = { ...state.feet };
    this.previousFeet = { ...state.feet };
  }

  /** 預測修正後，平滑地把渲染位置從舊值帶到新值。 */
  setStateKeepingRender(state: CharacterState): void {
    this.body.setState(state);
    this.currentFeet = { ...state.feet };
  }

  teleport(feet: Vec3, stance: Stance = 'standing'): void {
    this.body.teleport(feet, stance);
    this.desiredStance = stance;
    this.currentFeet = { ...feet };
    this.previousFeet = { ...feet };
  }

  interpolatedFeet(alpha: number, target: Vec3): Vec3 {
    target.x = this.previousFeet.x + (this.currentFeet.x - this.previousFeet.x) * alpha;
    target.y = this.previousFeet.y + (this.currentFeet.y - this.previousFeet.y) * alpha;
    target.z = this.previousFeet.z + (this.currentFeet.z - this.previousFeet.z) * alpha;
    return target;
  }

  consumeLanding(): number {
    const landing = this.pendingLanding;
    this.pendingLanding = 0;
    return landing;
  }

  snapshot(): CharacterSnapshot {
    return this.body.snapshot();
  }

  dispose(): void {
    this.body.dispose();
  }
}
