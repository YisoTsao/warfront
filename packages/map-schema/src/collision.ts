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

/**
 * 規則格狀地形（高度場）。比同樣解析度的三角網格小很多，地形碰撞優先使用。
 * 樣本排列：列（row）沿 +Z、欄（col）沿 +X，heights[row * cols + col] 為絕對高度（公尺）。
 * 每一格切成兩個三角形，對角線連接 (col+1, row) 與 (col, row+1)，與 Rapier 的高度場一致。
 */
export const HeightfieldColliderSchema = z.object({
  kind: z.literal('heightfield'),
  name: z.string().optional(),
  /** 第 0 列第 0 欄樣本的 X 與 Z（最小角） */
  origin: z.tuple([z.number(), z.number()]),
  /** 整個高度場在 X 與 Z 方向的長度（公尺） */
  size: z.tuple([z.number().positive(), z.number().positive()]),
  rows: z.number().int().min(2),
  cols: z.number().int().min(2),
  heights: z.array(z.number()),
  layer: CollisionLayerSchema.default('both'),
  material: z.string().optional(),
});

export const ColliderSchema = z.discriminatedUnion('kind', [BoxColliderSchema, TrimeshColliderSchema, HeightfieldColliderSchema]);
export type ColliderData = z.infer<typeof ColliderSchema>;
export type BoxColliderData = z.infer<typeof BoxColliderSchema>;
export type TrimeshColliderData = z.infer<typeof TrimeshColliderSchema>;
export type HeightfieldColliderData = z.infer<typeof HeightfieldColliderSchema>;

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
    } else if (collider.kind === 'heightfield' && collider.heights.length !== collider.rows * collider.cols) {
      throw new Error(`碰撞資料格式錯誤：colliders.${index} 的高度數量應為 rows × cols（${collider.rows * collider.cols}），實際 ${collider.heights.length}`);
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

/**
 * 高度場在 (x, z) 的地面高度，與 Rapier 的三角切分相同；範圍外回傳 null。
 * 伺服器與工具可以不經物理引擎直接查詢。
 */
export function heightfieldHeightAt(field: HeightfieldColliderData, x: number, z: number): number | null {
  const fx = ((x - field.origin[0]) / field.size[0]) * (field.cols - 1);
  const fz = ((z - field.origin[1]) / field.size[1]) * (field.rows - 1);
  if (!(fx >= 0 && fz >= 0 && fx <= field.cols - 1 && fz <= field.rows - 1)) {
    return null;
  }
  const c = Math.min(Math.floor(fx), field.cols - 2);
  const r = Math.min(Math.floor(fz), field.rows - 2);
  const u = fx - c;
  const v = fz - r;
  const h = field.heights;
  const h00 = h[r * field.cols + c]!;
  const h10 = h[r * field.cols + c + 1]!;
  const h01 = h[(r + 1) * field.cols + c]!;
  const h11 = h[(r + 1) * field.cols + c + 1]!;
  return u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
}
