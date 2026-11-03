import { pointInBounds, type MapManifest } from '@frontline/map-schema';
import type { Vec3 } from '@frontline/shared';

export type WaterDepth = 'none' | 'shallow' | 'deep';

/** 腳底所在的水域深度（取最深的）。 */
export function waterDepthAt(manifest: MapManifest, feet: Vec3): WaterDepth {
  let depth: WaterDepth = 'none';
  for (const volume of manifest.waterVolumes) {
    if (pointInBounds(feet, volume.bounds)) {
      if (volume.depth === 'deep') {
        return 'deep';
      }
      depth = 'shallow';
    }
  }
  return depth;
}

/** 水中移動速度倍率（前後端共用）。 */
export function waterSpeedScale(depth: WaterDepth): number {
  return depth === 'deep' ? 0.5 : depth === 'shallow' ? 0.8 : 1;
}
