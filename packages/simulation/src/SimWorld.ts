import type { HeightfieldColliderData, MapCollision, MapManifest } from '@frontline/map-schema';
import type { Vec3 } from '@frontline/shared';
import { BULLET_QUERY_GROUPS, GROUP_CHARACTER, interactionGroups, layerMembership } from './groups';
import { RAPIER } from './rapier';

export interface WorldHit {
  distance: number;
  point: Vec3;
  normal: Vec3;
  material: string;
}

/**
 * 一場對戰（或單機）的物理世界：只有靜態地圖碰撞與角色。
 * 前端與伺服器用同一份碰撞資料建立，結果才會一致。
 */
export class SimWorld {
  readonly world: RAPIER.World;
  private readonly materials = new Map<number, string>();

  constructor(
    readonly manifest: MapManifest,
    collision: MapCollision,
    readonly stepSeconds: number,
  ) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = stepSeconds;
    for (const collider of collision.colliders) {
      const groups = interactionGroups(layerMembership(collider.layer), 0xffff & ~GROUP_CHARACTER);
      let desc: RAPIER.ColliderDesc | null;
      if (collider.kind === 'box') {
        const [hx, hy, hz] = collider.halfExtents;
        const [x, y, z, w] = collider.rotation;
        desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(...collider.center)
          .setRotation({ x, y, z, w });
      } else if (collider.kind === 'heightfield') {
        desc = heightfieldDesc(collider);
      } else {
        desc = RAPIER.ColliderDesc.trimesh(new Float32Array(collider.vertices), new Uint32Array(collider.indices));
      }
      if (!desc) {
        continue;
      }
      desc.setCollisionGroups(groups);
      const created = this.world.createCollider(desc);
      this.materials.set(created.handle, collider.material ?? 'default');
    }
    // 先推進一次，讓靜態碰撞體進入查詢結構。
    this.world.step();
  }

  step(): void {
    this.world.step();
  }

  /** 子彈射線：只檢查擋子彈的地圖碰撞（角色另外以 hitbox 判定）。 */
  castBullet(origin: Vec3, direction: Vec3, maxDistance: number): WorldHit | null {
    const ray = new RAPIER.Ray(origin, direction);
    const hit = this.world.castRayAndGetNormal(ray, maxDistance, true, undefined, BULLET_QUERY_GROUPS);
    if (!hit) {
      return null;
    }
    const distance = hit.timeOfImpact;
    return {
      distance,
      point: { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      material: this.materials.get(hit.collider.handle) ?? 'default',
    };
  }

  /** 兩點之間是否有擋子彈的障礙（視線檢查）。 */
  lineOfSight(from: Vec3, to: Vec3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-4) {
      return true;
    }
    const hit = this.castBullet(from, { x: dx / distance, y: dy / distance, z: dz / distance }, distance);
    return hit === null || hit.distance >= distance - 0.05;
  }

  /** 從高處往下找地面高度（放置出生點、手榴彈、bot 用）。 */
  groundHeight(x: number, z: number, fromY = 200): number | null {
    const hit = this.castBullet({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }, fromY + 100);
    return hit ? hit.point.y : null;
  }

  dispose(): void {
    this.world.free();
  }
}

/**
 * Rapier 的高度場以碰撞體位置為中心，矩陣為欄優先（column-major），列沿 Z、欄沿 X，
 * 參數是格數（樣本數 − 1）。地圖資料是列優先，這裡轉置。
 */
function heightfieldDesc(field: HeightfieldColliderData): RAPIER.ColliderDesc {
  const { rows, cols } = field;
  const heights = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r + c * rows] = field.heights[r * cols + c]!;
    }
  }
  return RAPIER.ColliderDesc.heightfield(rows - 1, cols - 1, heights, { x: field.size[0], y: 1, z: field.size[1] }).setTranslation(
    field.origin[0] + field.size[0] / 2,
    0,
    field.origin[1] + field.size[1] / 2,
  );
}
