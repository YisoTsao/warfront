import { z } from 'zod';

/**
 * 地圖碰撞資料。與渲染網格完全分開：前端的角色移動與伺服器的移動驗證、命中判定都讀這一份。
 * layer：movement 只擋人、bullet 只擋子彈、both 兩者都擋。
 */
export const CollisionLayerSchema = z.enum(['movement', 'bullet', 'both']);
export type CollisionLayer = z.infer<typeof CollisionLayerSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const BoxColliderSchema = z.object({
  kind: z.literal('box'),
  name: z.string().optional(),
  center: vec3,
  halfExtents: vec3,
  /** 四元數 [x, y, z, w] */
  rotation: quat.default([0, 0, 0, 1]),
  layer: CollisionLayerSchema.default('both'),
  /** 材質，用於命中特效與之後的穿透規則 */
  material: z.string().optional(),
});

export const TrimeshColliderSchema = z.object({
  kind: z.literal('trimesh'),
  name: z.string().optional(),
  /** 世界座標頂點，攤平為 [x0, y0, z0, x1, ...] */
  vertices: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  layer: CollisionLayerSchema.default('both'),
  material: z.string().optional(),
});

export const ColliderSchema = z.discriminatedUnion('kind', [BoxColliderSchema, TrimeshColliderSchema]);
export type ColliderData = z.infer<typeof ColliderSchema>;
export type BoxColliderData = z.infer<typeof BoxColliderSchema>;
export type TrimeshColliderData = z.infer<typeof TrimeshColliderSchema>;

export const MapCollisionSchema = z.object({
  schemaVersion: z.literal(1),
  colliders: z.array(ColliderSchema),
});
export type MapCollision = z.infer<typeof MapCollisionSchema>;

export function parseMapCollision(input: unknown): MapCollision {
  const result = MapCollisionSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`碰撞資料格式錯誤：${details}`);
  }
  for (const [index, collider] of result.data.colliders.entries()) {
    if (collider.kind === 'trimesh') {
      if (collider.vertices.length % 3 !== 0 || collider.indices.length % 3 !== 0) {
        throw new Error(`碰撞資料格式錯誤：colliders.${index} 的頂點或索引數量不是 3 的倍數`);
      }
      const vertexCount = collider.vertices.length / 3;
      if (collider.indices.some((i) => i >= vertexCount)) {
        throw new Error(`碰撞資料格式錯誤：colliders.${index} 的索引超出頂點範圍`);
      }
    }
  }
  return result.data;
}

export function blocksMovement(layer: CollisionLayer): boolean {
  return layer !== 'bullet';
}

export function blocksBullets(layer: CollisionLayer): boolean {
  return layer !== 'movement';
}
