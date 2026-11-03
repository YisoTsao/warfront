import type { CollisionLayer } from '@frontline/map-schema';

/**
 * Rapier 碰撞群組：高 16 位為「屬於」，低 16 位為「會與誰互動」。
 * 地圖碰撞依 layer 決定屬於移動、子彈或兩者。
 */
export const GROUP_MOVEMENT = 1 << 0;
export const GROUP_BULLET = 1 << 1;
export const GROUP_CHARACTER = 1 << 2;

export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export function layerMembership(layer: CollisionLayer): number {
  switch (layer) {
    case 'movement':
      return GROUP_MOVEMENT;
    case 'bullet':
      return GROUP_BULLET;
    default:
      return GROUP_MOVEMENT | GROUP_BULLET;
  }
}

/** 角色控制器只與擋移動的碰撞互動。 */
export const MOVEMENT_QUERY_GROUPS = interactionGroups(0xffff, GROUP_MOVEMENT);
/** 子彈射線只與擋子彈的碰撞互動。 */
export const BULLET_QUERY_GROUPS = interactionGroups(0xffff, GROUP_BULLET);
