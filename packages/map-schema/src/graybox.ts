import type { MapCollision } from './collision';
import { GRAYBOX_LAYOUT, type BoxSpec } from './grayboxLayout';
import { MAP_SCHEMA_VERSION, type MapManifest } from './manifest';

export { GRAYBOX_LAYOUT, TUNNEL_CLEARANCE, ramp, stairs, type BoxSpec, type GrayboxLayout, type SurfaceKind } from './grayboxLayout';

export const GRAYBOX_MAP_ID = 'graybox';

/** 由 X、Y 軸旋轉（YXZ 順序）算出四元數，與前端建置網格的方式一致。 */
export function boxRotationQuaternion(spec: Pick<BoxSpec, 'rotationX' | 'rotationY'>): [number, number, number, number] {
  const hx = (spec.rotationX ?? 0) / 2;
  const hy = (spec.rotationY ?? 0) / 2;
  const cx = Math.cos(hx);
  const sx = Math.sin(hx);
  const cy = Math.cos(hy);
  const sy = Math.sin(hy);
  // q = qY * qX
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}

export function grayboxCollision(): MapCollision {
  return {
    schemaVersion: 1,
    colliders: GRAYBOX_LAYOUT.boxes.map((box) => ({
      kind: 'box' as const,
      name: box.name,
      center: [box.position[0], box.position[1], box.position[2]],
      halfExtents: [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2],
      rotation: boxRotationQuaternion(box),
      layer: 'both' as const,
      material: box.surface === 'floor' ? 'dirt' : 'concrete',
    })),
  };
}

/** 灰盒測試地圖的 manifest：沒有 GLB 分塊，視覺由前端依方塊資料建立。 */
export function grayboxManifest(): MapManifest {
  const spawnRow = (team: 'alpha' | 'bravo', z: number, yaw: number) =>
    [-12, -6, 0, 6, 12].map((x, i) => ({ id: `${team}-${i + 1}`, team, position: [x, 0, z] as [number, number, number], yaw }));
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    id: GRAYBOX_MAP_ID,
    name: '灰盒測試場',
    bounds: { min: [-60, -5, -60], max: [60, 40, 60] },
    killPlaneY: GRAYBOX_LAYOUT.killPlaneY,
    environment: {
      skyColor: '#9fb4c7',
      fogColor: '#9fb4c7',
      fogNear: 60,
      fogFar: 220,
      sunDirection: [-0.48, -0.84, -0.3],
      sunColor: '#fff1dc',
      sunIntensity: 2.2,
      hemisphereSky: '#dfe8f2',
      hemisphereGround: '#4a4a3a',
      hemisphereIntensity: 1.1,
    },
    chunks: [],
    collision: 'builtin:graybox',
    spawns: [
      { id: 'solo', position: [...GRAYBOX_LAYOUT.spawn.feet], yaw: GRAYBOX_LAYOUT.spawn.yaw },
      ...spawnRow('alpha', 52, 0),
      ...spawnRow('bravo', -52, Math.PI),
    ],
    objectives: [
      { id: 'A', name: 'A 坡道', position: [-40, 0, 30], radius: 8 },
      { id: 'B', name: 'B 中央', position: [0, 0, -12], radius: 8 },
      { id: 'C', name: 'C 通道', position: [36, 0, 10], radius: 8 },
    ],
    restrictedAreas: [],
    waterVolumes: [],
  };
}
