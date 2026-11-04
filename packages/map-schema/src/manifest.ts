import { z } from 'zod';

/**
 * 地圖 manifest：由 tools/map-build 從 Blender 匯出的 GLB 產生，前端與伺服器都會驗證。
 * 單位為公尺，Y 軸朝上。
 */
export const MAP_SCHEMA_VERSION = 1;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const TeamIdSchema = z.enum(['alpha', 'bravo']);
export type TeamId = z.infer<typeof TeamIdSchema>;

export const BoundsSchema = z.object({ min: vec3, max: vec3 });
export type Bounds = z.infer<typeof BoundsSchema>;

export const SpawnPointSchema = z.object({
  id: z.string(),
  /** 沒有指定隊伍時兩隊共用 */
  team: TeamIdSchema.optional(),
  /** 腳底位置 */
  position: vec3,
  /** 朝向（弧度，0 = 面向 -Z） */
  yaw: z.number(),
});
export type SpawnPoint = z.infer<typeof SpawnPointSchema>;

export const ObjectiveSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: vec3,
  /** 佔領半徑（公尺） */
  radius: z.number().positive(),
  /** 開局時的擁有方 */
  initialOwner: TeamIdSchema.optional(),
});
export type Objective = z.infer<typeof ObjectiveSchema>;

export const VolumeSchema = z.object({
  id: z.string(),
  bounds: BoundsSchema,
});

export const RestrictedAreaSchema = VolumeSchema.extend({
  /** 只限制某一隊（例如對方出生區）；不填則兩隊都不能進入 */
  team: TeamIdSchema.optional(),
  /** 進入後幾秒會被判定死亡 */
  graceSeconds: z.number().nonnegative().default(10),
});
export type RestrictedArea = z.infer<typeof RestrictedAreaSchema>;

export const WaterVolumeSchema = VolumeSchema.extend({
  depth: z.enum(['shallow', 'deep']),
});
export type WaterVolume = z.infer<typeof WaterVolumeSchema>;

export const LodLevelSchema = z.object({
  path: z.string(),
  /** 超過這個距離就換下一級（公尺）；最後一級可以省略 */
  maxDistance: z.number().positive().optional(),
});

export const ChunkSchema = z.object({
  id: z.string(),
  /** 相對於 manifest 的 GLB 路徑 */
  path: z.string(),
  bounds: BoundsSchema,
  /** 數字越小越先載入；地形與出生區通常為 0 */
  priority: z.number().int().nonnegative().default(1),
  /** 超過這個距離才卸載／不載入；不填表示永遠載入 */
  streamDistance: z.number().positive().optional(),
  byteLength: z.number().int().nonnegative().optional(),
});
export type MapChunk = z.infer<typeof ChunkSchema>;

export const EnvironmentSchema = z.object({
  skyColor: color,
  fogColor: color,
  fogNear: z.number().nonnegative(),
  fogFar: z.number().positive(),
  sunDirection: vec3,
  sunColor: color,
  sunIntensity: z.number().nonnegative(),
  hemisphereSky: color,
  hemisphereGround: color,
  hemisphereIntensity: z.number().nonnegative(),
});
export type MapEnvironment = z.infer<typeof EnvironmentSchema>;

export const MapManifestSchema = z.object({
  schemaVersion: z.literal(MAP_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  /** 可遊玩範圍；出界時回收 */
  bounds: BoundsSchema,
  killPlaneY: z.number(),
  environment: EnvironmentSchema,
  chunks: z.array(ChunkSchema),
  /** 相對路徑，指向 MapCollision JSON */
  collision: z.string(),
  /** 共用網格庫（GLB）：分塊內 extras.library_mesh 指向這裡的網格；先於分塊載入 */
  library: z.object({ path: z.string(), byteLength: z.number().int().nonnegative().optional() }).optional(),
  spawns: z.array(SpawnPointSchema).min(1),
  objectives: z.array(ObjectiveSchema).default([]),
  restrictedAreas: z.array(RestrictedAreaSchema).default([]),
  waterVolumes: z.array(WaterVolumeSchema).default([]),
  /** 產生資訊，方便追蹤來源 */
  source: z
    .object({ file: z.string(), generatedAt: z.string(), generator: z.string() })
    .optional(),
});
export type MapManifest = z.infer<typeof MapManifestSchema>;

/** 驗證 manifest；失敗時丟出含路徑的錯誤訊息。 */
export function parseMapManifest(input: unknown): MapManifest {
  const result = MapManifestSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`地圖 manifest 格式錯誤：${details}`);
  }
  return result.data;
}

export function pointInBounds(p: readonly [number, number, number] | { x: number; y: number; z: number }, b: Bounds): boolean {
  const [x, y, z] = Array.isArray(p) ? p : [(p as { x: number }).x, (p as { y: number }).y, (p as { z: number }).z];
  return x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2];
}

export function horizontalDistanceToBounds(x: number, z: number, b: Bounds): number {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
  return Math.hypot(dx, dz);
}
