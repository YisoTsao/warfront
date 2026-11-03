import RAPIER from '@dimforge/rapier3d-compat';

let initPromise: Promise<void> | null = null;

/** Rapier 的 WASM 只需初始化一次。 */
export function initPhysics(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/** 包裝 Rapier World，提供固定步長推進與靜態碰撞建立。 */
export class PhysicsWorld {
  readonly world: RAPIER.World;

  constructor(stepSeconds: number) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = stepSeconds;
  }

  /** 建立固定（不會動）的盒狀碰撞體。rotation 為四元數。 */
  addStaticBox(
    halfExtents: { x: number; y: number; z: number },
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
  ): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation);
    return this.world.createCollider(desc);
  }

  step(): void {
    this.world.step();
  }

  dispose(): void {
    this.world.free();
  }
}

export { RAPIER };
