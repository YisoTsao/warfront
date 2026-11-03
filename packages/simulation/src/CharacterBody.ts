import {
  CAPSULE,
  MOVEMENT,
  canSprint,
  capsuleHalfHeight,
  horizontalNormal,
  isWalkableNormal,
  resolveBlockedVelocity,
  resolveLocomotion,
  resolveStance,
  stepHorizontalVelocity,
  stepVerticalVelocity,
  targetSpeed,
  wishDirection,
  type Locomotion,
  type MoveInput,
  type Stance,
  type Vec2,
  type Vec3,
} from '@frontline/shared';
import { GROUP_CHARACTER, MOVEMENT_QUERY_GROUPS, interactionGroups } from './groups';
import { RAPIER } from './rapier';
import type { SimWorld } from './SimWorld';

const DEG = Math.PI / 180;
const CONTROLLER_OFFSET = 0.02;
const STAND_CHECK_SHRINK = 0.02;
const STAND_CHECK_LIFT = 0.05;
/** 朝牆面的實際位移低於預期的這個比例，才視為被牆擋住 */
const BLOCKED_MOVEMENT_RATIO = 0.9;
/** 臥倒時膠囊的圓柱部分不能為 0，給一個極小值 */
const MIN_CYLINDER_HALF = 0.01;

/** 一個模擬步驟的角色輸入。前端預測、伺服器權威與 bot 都用同一種格式。 */
export interface CharacterInput {
  move: MoveInput;
  /** 這一步新按下跳躍（邊緣事件） */
  jump: boolean;
  /** 想要的姿勢（不是按鍵切換），重播時才會一致 */
  stance: Stance;
  aim: boolean;
}

export const IDLE_INPUT: CharacterInput = {
  move: { forward: 0, right: 0, sprint: false },
  jump: false,
  stance: 'standing',
  aim: false,
};

/** 可序列化的角色狀態，供網路同步與預測修正使用。 */
export interface CharacterState {
  feet: Vec3;
  velocity: Vec3;
  intended: Vec2;
  grounded: boolean;
  stance: Stance;
}

export interface CharacterSnapshot extends CharacterState {
  locomotion: Locomotion;
}

function cylinderHalf(stance: Stance): number {
  return Math.max(MIN_CYLINDER_HALF, capsuleHalfHeight(stance) - CAPSULE.radius);
}

/**
 * Rapier 運動學角色控制器包裝。移動規則來自 @frontline/shared。
 * 角色之間不互相碰撞（避免各端預測不一致），只與地圖的移動碰撞互動。
 */
export class CharacterBody {
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private intended: Vec2 = { x: 0, z: 0 };
  private grounded = false;
  private stance: Stance = 'standing';
  private locomotion: Locomotion = 'idle';
  private feet: Vec3;
  private lastLandingSpeed = 0;
  /** 兵種或武器造成的速度倍率 */
  speedScale = 1;

  constructor(
    private readonly sim: SimWorld,
    spawnFeet: Vec3,
  ) {
    const world = sim.world;
    const half = capsuleHalfHeight('standing');
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawnFeet.x, spawnFeet.y + half, spawnFeet.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(cylinderHalf('standing'), CAPSULE.radius).setCollisionGroups(
        interactionGroups(GROUP_CHARACTER, 0),
      ),
      this.body,
    );
    this.controller = world.createCharacterController(CONTROLLER_OFFSET);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle(MOVEMENT.maxSlopeClimbDegrees * DEG);
    this.controller.setMinSlopeSlideAngle(MOVEMENT.minSlopeSlideDegrees * DEG);
    this.controller.enableAutostep(MOVEMENT.stepHeight, MOVEMENT.stepMinWidth, false);
    this.controller.enableSnapToGround(MOVEMENT.snapToGroundDistance);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.feet = { ...spawnFeet };
  }

  /**
   * 以固定 dt 推進一步。呼叫後需要 sim.step()（或一次推進所有角色後再 step）。
   * 回傳是否在這一步起跳。
   */
  step(input: CharacterInput, yaw: number, dt: number): { jumped: boolean; landed: number } {
    this.updateStance(input.stance);

    const aiming = input.aim;
    const sprinting = canSprint(input.move, this.stance) && !aiming;
    const wish = wishDirection(input.move, yaw);
    const horizontal = stepHorizontalVelocity(
      this.intended,
      wish,
      targetSpeed(this.stance, sprinting, aiming) * this.speedScale,
      this.grounded,
      dt,
    );
    const wasGrounded = this.grounded;
    const fallSpeed = -this.velocity.y;
    const vertical = stepVerticalVelocity(this.velocity.y, this.grounded, input.jump, this.stance, dt);

    const desired = { x: horizontal.x * dt, y: vertical.velocityY * dt, z: horizontal.z * dt };
    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, MOVEMENT_QUERY_GROUPS);
    const moved = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded() && !vertical.jumped;

    let velocityY = vertical.velocityY;
    if (velocityY > 0 && moved.y < desired.y - 1e-4) {
      velocityY = 0;
    }
    if (this.grounded && velocityY < 0) {
      velocityY = 0;
    }
    // 地面上保留預期速度，Rapier 的沿牆滑動與自動跨步才拿得到完整輸入；
    // 空中移除真正擋住角色的牆的分量，避免撞牆後殘留看不見的慣性。
    this.intended = this.grounded ? horizontal : resolveBlockedVelocity(horizontal, this.collectBlockingWalls(desired, moved));
    this.velocity = { x: moved.x / dt, y: velocityY, z: moved.z / dt };

    const center = this.body.translation();
    const next = { x: center.x + moved.x, y: center.y + moved.y, z: center.z + moved.z };
    this.body.setNextKinematicTranslation(next);
    // 立即更新碰撞體位置，同一個 tick 內的下一次查詢（例如重播）才會正確。
    this.body.setTranslation(next, false);
    this.sim.world.propagateModifiedBodyPositionsToColliders();
    this.feet = { x: next.x, y: next.y - capsuleHalfHeight(this.stance), z: next.z };

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.locomotion = resolveLocomotion(this.grounded, speed, sprinting);
    this.lastLandingSpeed = !wasGrounded && this.grounded && fallSpeed > 0 ? fallSpeed : 0;
    return { jumped: vertical.jumped, landed: this.lastLandingSpeed };
  }

  getState(): CharacterState {
    return {
      feet: { ...this.feet },
      velocity: { ...this.velocity },
      intended: { ...this.intended },
      grounded: this.grounded,
      stance: this.stance,
    };
  }

  /** 還原狀態（預測修正、重生、傳送）。 */
  setState(state: CharacterState): void {
    if (state.stance !== this.stance) {
      this.collider.setHalfHeight(cylinderHalf(state.stance));
      this.stance = state.stance;
    }
    this.placeFeet(state.feet);
    this.velocity = { ...state.velocity };
    this.intended = { ...state.intended };
    this.grounded = state.grounded;
  }

  snapshot(): CharacterSnapshot {
    return { ...this.getState(), locomotion: this.locomotion };
  }

  get position(): Vec3 {
    return this.feet;
  }

  get currentStance(): Stance {
    return this.stance;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  teleport(feet: Vec3, stance: Stance = 'standing'): void {
    this.setState({ feet, velocity: { x: 0, y: 0, z: 0 }, intended: { x: 0, z: 0 }, grounded: false, stance });
  }

  dispose(): void {
    this.sim.world.removeCharacterController(this.controller);
    this.sim.world.removeRigidBody(this.body);
  }

  private placeFeet(feet: Vec3): void {
    const center = { x: feet.x, y: feet.y + capsuleHalfHeight(this.stance), z: feet.z };
    this.body.setTranslation(center, true);
    this.body.setNextKinematicTranslation(center);
    this.sim.world.propagateModifiedBodyPositionsToColliders();
    this.feet = { ...feet };
  }

  private collectBlockingWalls(desired: Vec3, moved: Vec3): Vec2[] {
    const walls: Vec2[] = [];
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const collision = this.controller.computedCollision(i);
      if (!collision || isWalkableNormal(collision.normal1)) {
        continue;
      }
      const n = horizontalNormal(collision.normal1);
      if (!n) {
        continue;
      }
      const desiredInto = -(desired.x * n.x + desired.z * n.z);
      if (desiredInto <= 1e-6) {
        continue;
      }
      const movedInto = -(moved.x * n.x + moved.z * n.z);
      if (movedInto < desiredInto * BLOCKED_MOVEMENT_RATIO) {
        walls.push(n);
      }
    }
    return walls;
  }

  private updateStance(desired: Stance): void {
    const next = resolveStance(this.stance, desired, (s) => this.fits(s));
    if (next === this.stance) {
      return;
    }
    const oldHalf = capsuleHalfHeight(this.stance);
    const newHalf = capsuleHalfHeight(next);
    const center = this.body.translation();
    this.collider.setHalfHeight(cylinderHalf(next));
    const moved = { x: center.x, y: center.y + (newHalf - oldHalf), z: center.z };
    this.body.setTranslation(moved, true);
    this.body.setNextKinematicTranslation(moved);
    this.sim.world.propagateModifiedBodyPositionsToColliders();
    this.stance = next;
  }

  /** 換成較高姿勢前，檢查頭頂空間。 */
  private fits(stance: Stance): boolean {
    const center = this.body.translation();
    const feetY = center.y - capsuleHalfHeight(this.stance);
    const radius = CAPSULE.radius - STAND_CHECK_SHRINK;
    const half = capsuleHalfHeight(stance) - STAND_CHECK_LIFT / 2;
    const shape = new RAPIER.Capsule(Math.max(MIN_CYLINDER_HALF, half - radius), radius);
    const position = { x: center.x, y: feetY + STAND_CHECK_LIFT + half, z: center.z };
    const hit = this.sim.world.intersectionWithShape(
      position,
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      MOVEMENT_QUERY_GROUPS,
      this.collider,
      this.body,
    );
    return hit === null;
  }
}
