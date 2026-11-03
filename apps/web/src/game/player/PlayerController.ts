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
  type Stance,
  type Vec2,
} from '@frontline/shared';
import type { SimulationInput } from '../input/InputManager';
import { RAPIER, type PhysicsWorld } from '../physics/PhysicsWorld';

const DEG = Math.PI / 180;
/** 角色控制器與牆面保持的間隙（公尺） */
const CONTROLLER_OFFSET = 0.02;
/** 站起檢查時，測試膠囊比實際略細且離地一點，避免碰到牆面或地板就判定不能站 */
const STAND_CHECK_SHRINK = 0.02;
const STAND_CHECK_LIFT = 0.05;
/** 朝牆面的實際位移低於預期的這個比例，才視為被牆擋住 */
const BLOCKED_MOVEMENT_RATIO = 0.9;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 玩家模擬狀態的唯讀快照，供相機、HUD、除錯面板與之後的網路同步使用。 */
export interface PlayerSnapshot {
  /** 腳底位置 */
  feet: Vec3;
  velocity: Vec3;
  grounded: boolean;
  stance: Stance;
  locomotion: Locomotion;
}

export interface LandingEvent {
  /** 落地前的向下速度（公尺／秒，正值） */
  impactSpeed: number;
}

/**
 * 以 Rapier 運動學角色控制器實作的第一人稱移動。
 * 移動規則（加速度、衝刺、跳躍）來自 @frontline/shared，之後伺服器可用同一份規則重播。
 */
export class PlayerController {
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  /** 實際速度（位移 ÷ dt），對外回報用 */
  private velocity: Vec3 = { x: 0, y: 0, z: 0 };
  /** 依輸入推進的預期水平速度，作為下一步加速的起點 */
  private intended: Vec2 = { x: 0, z: 0 };
  private grounded = false;
  private stance: Stance = 'standing';
  private wantsCrouch = false;
  private locomotion: Locomotion = 'idle';
  private previousFeet: Vec3;
  private currentFeet: Vec3;
  private pendingLanding: LandingEvent | null = null;
  private readonly spawnFeet: Vec3;

  constructor(
    private readonly physics: PhysicsWorld,
    spawnFeet: Vec3,
    private readonly killPlaneY: number,
  ) {
    const world = physics.world;
    const half = CAPSULE.standingHalfHeight;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawnFeet.x, spawnFeet.y + half, spawnFeet.z),
    );
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(half - CAPSULE.radius, CAPSULE.radius), this.body);

    this.controller = world.createCharacterController(CONTROLLER_OFFSET);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle(MOVEMENT.maxSlopeClimbDegrees * DEG);
    this.controller.setMinSlopeSlideAngle(MOVEMENT.minSlopeSlideDegrees * DEG);
    this.controller.enableAutostep(MOVEMENT.stepHeight, MOVEMENT.stepMinWidth, false);
    this.controller.enableSnapToGround(MOVEMENT.snapToGroundDistance);
    this.controller.setApplyImpulsesToDynamicBodies(false);

    this.currentFeet = { ...spawnFeet };
    this.previousFeet = { ...spawnFeet };
    this.spawnFeet = { ...spawnFeet };
  }

  /** 以固定 dt 推進一步。yaw 為目前相機水平角（弧度）。呼叫後由 Game 執行 world.step()。 */
  step(input: SimulationInput, yaw: number, dt: number): void {
    this.previousFeet = { ...this.currentFeet };

    if (input.crouchToggled) {
      this.wantsCrouch = !this.wantsCrouch;
    }
    this.updateStance();

    const sprinting = canSprint(input.move, this.stance);
    const wish = wishDirection(input.move, yaw);
    const horizontal = stepHorizontalVelocity(
      this.intended,
      wish,
      targetSpeed(this.stance, sprinting),
      this.grounded,
      dt,
    );
    const wasGrounded = this.grounded;
    const fallSpeed = -this.velocity.y;
    const vertical = stepVerticalVelocity(this.velocity.y, this.grounded, input.jumpPressed, this.stance, dt);

    const desired = { x: horizontal.x * dt, y: vertical.velocityY * dt, z: horizontal.z * dt };
    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const moved = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded() && !vertical.jumped;

    let velocityY = vertical.velocityY;
    if (velocityY > 0 && moved.y < desired.y - 1e-4) {
      // 撞到天花板：停止上升。
      velocityY = 0;
    }
    if (this.grounded && velocityY < 0) {
      velocityY = 0;
    }
    // 地面上保留預期速度（加速度本身就會把它限制在輸入的目標速度），
    // Rapier 的沿牆滑動與自動跨步才拿得到完整的輸入；若在此歸零，上樓梯會卡在第一階。
    // 空中則移除真正擋住角色的牆的分量，避免撞牆後殘留看不見的慣性。
    this.intended = this.grounded ? horizontal : resolveBlockedVelocity(horizontal, this.collectBlockingWalls(desired, moved));
    this.velocity = { x: moved.x / dt, y: velocityY, z: moved.z / dt };

    const center = this.body.translation();
    const next = { x: center.x + moved.x, y: center.y + moved.y, z: center.z + moved.z };
    this.body.setNextKinematicTranslation(next);
    this.currentFeet = { x: next.x, y: next.y - capsuleHalfHeight(this.stance), z: next.z };

    if (!wasGrounded && this.grounded && fallSpeed > 0) {
      this.pendingLanding = { impactSpeed: fallSpeed };
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.locomotion = resolveLocomotion(this.grounded, speed, sprinting);

    if (this.currentFeet.y < this.killPlaneY) {
      this.teleport(this.spawnFeet);
    }
  }

  /** 把玩家放到指定腳底位置並清除速度（重生、出界回收、測試用）。 */
  teleport(feet: Vec3): void {
    const half = capsuleHalfHeight(this.stance);
    const center = { x: feet.x, y: feet.y + half, z: feet.z };
    this.body.setTranslation(center, true);
    // 同時覆蓋這一步已排定的運動學目標，否則下一次 world.step() 會把玩家移回去。
    this.body.setNextKinematicTranslation(center);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    this.velocity = { x: 0, y: 0, z: 0 };
    this.intended = { x: 0, z: 0 };
    this.grounded = false;
    this.currentFeet = { ...feet };
    this.previousFeet = { ...feet };
  }

  /** 在前後兩個模擬步驟之間內插的腳底位置，給渲染使用。 */
  interpolatedFeet(alpha: number, target: Vec3): Vec3 {
    target.x = this.previousFeet.x + (this.currentFeet.x - this.previousFeet.x) * alpha;
    target.y = this.previousFeet.y + (this.currentFeet.y - this.previousFeet.y) * alpha;
    target.z = this.previousFeet.z + (this.currentFeet.z - this.previousFeet.z) * alpha;
    return target;
  }

  /** 取出自上次呼叫以來的落地事件（若有）。 */
  consumeLanding(): LandingEvent | null {
    const landing = this.pendingLanding;
    this.pendingLanding = null;
    return landing;
  }

  snapshot(): PlayerSnapshot {
    return {
      feet: { ...this.currentFeet },
      velocity: { ...this.velocity },
      grounded: this.grounded,
      stance: this.stance,
      locomotion: this.locomotion,
    };
  }

  dispose(): void {
    this.physics.world.removeCharacterController(this.controller);
  }

  /**
   * 這一步真正擋住角色的牆（水平單位法線）。可行走的坡面不算；
   * 角色朝某面牆的實際位移若接近預期（例如自動跨上了台階），也不算被擋住。
   */
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

  private updateStance(): void {
    const canStand = this.stance === 'standing' || this.hasHeadroomToStand();
    const next = resolveStance(this.wantsCrouch, canStand);
    if (next !== this.stance) {
      this.setStance(next);
    }
  }

  /** 換姿勢時調整膠囊高度，並維持腳底位置不變。 */
  private setStance(next: Stance): void {
    const oldHalf = capsuleHalfHeight(this.stance);
    const newHalf = capsuleHalfHeight(next);
    const center = this.body.translation();
    this.collider.setHalfHeight(newHalf - CAPSULE.radius);
    this.body.setTranslation({ x: center.x, y: center.y + (newHalf - oldHalf), z: center.z }, true);
    // 讓碰撞體立即套用新位置，這一步的移動計算才不會用到舊位置。
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    this.stance = next;
  }

  private hasHeadroomToStand(): boolean {
    const feet = this.body.translation();
    const half = capsuleHalfHeight(this.stance);
    const feetY = feet.y - half;
    const radius = CAPSULE.radius - STAND_CHECK_SHRINK;
    const standHalf = CAPSULE.standingHalfHeight - STAND_CHECK_LIFT / 2;
    const shape = new RAPIER.Capsule(standHalf - radius, radius);
    const position = { x: feet.x, y: feetY + STAND_CHECK_LIFT + standHalf, z: feet.z };
    const hit = this.physics.world.intersectionWithShape(
      position,
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.collider,
      this.body,
    );
    return hit === null;
  }
}
