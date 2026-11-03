/**
 * Blender 端的命名與自訂屬性慣例。tools/map-build 依此把節點分類。
 * 規則：節點本身或最近的祖先節點名稱以下列前綴開頭，即屬於該類別；
 * 也可以用自訂屬性 frontline_role 明確指定（優先）。
 */
export const COLLECTION_ROLES = [
  'ENV_Terrain',
  'ENV_Rocks',
  'ENV_Trees',
  'ENV_Foliage',
  'ENV_Buildings',
  'ENV_Props',
  'ENV_Weapons',
  'COLLISION_Static',
  'COLLISION_Bullet',
  'GAMEPLAY_SpawnPoints',
  'GAMEPLAY_Objectives',
  'GAMEPLAY_RestrictedAreas',
  'GAMEPLAY_WaterVolumes',
  'LIGHTING_Reference',
] as const;

export type CollectionRole = (typeof COLLECTION_ROLES)[number];

export type RoleCategory = 'visual' | 'collision' | 'gameplay' | 'ignored';

export function roleCategory(role: CollectionRole): RoleCategory {
  if (role.startsWith('ENV_')) {
    return role === 'ENV_Weapons' ? 'ignored' : 'visual';
  }
  if (role.startsWith('COLLISION_')) {
    return 'collision';
  }
  if (role.startsWith('GAMEPLAY_')) {
    return 'gameplay';
  }
  return 'ignored';
}

/** 依名稱（或 frontline_role 屬性）判斷角色；不符合任何前綴時回傳 null。 */
export function matchRole(name: string, extras?: Record<string, unknown>): CollectionRole | null {
  const explicit = extras?.frontline_role;
  if (typeof explicit === 'string') {
    const found = COLLECTION_ROLES.find((r) => r === explicit);
    if (found) {
      return found;
    }
  }
  return COLLECTION_ROLES.find((role) => name === role || name.startsWith(`${role}.`) || name.startsWith(`${role}_`)) ?? null;
}

/** LOD 命名：Tree_LOD0、Tree_LOD1… */
export function parseLodName(name: string): { base: string; level: number } | null {
  const match = /^(.*)_LOD(\d+)$/.exec(name);
  if (!match?.[1] || match[2] === undefined) {
    return null;
  }
  return { base: match[1], level: Number(match[2]) };
}
