import type { MapEnvironment } from '@frontline/map-schema';
import * as THREE from 'three';

export interface EnvironmentHandles {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  dispose(): void;
}

/** 依地圖 manifest 設定天空、霧與光源。太陽陰影跟著玩家移動，只涵蓋附近範圍。 */
export function applyEnvironment(scene: THREE.Scene, env: MapEnvironment): EnvironmentHandles {
  const sky = new THREE.Color(env.skyColor);
  scene.background = sky;
  scene.fog = new THREE.Fog(new THREE.Color(env.fogColor), env.fogNear, env.fogFar);

  const hemisphere = new THREE.HemisphereLight(env.hemisphereSky, env.hemisphereGround, env.hemisphereIntensity);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  const [dx, dy, dz] = env.sunDirection;
  sun.position.set(-dx * 80, -dy * 80, -dz * 80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const extent = 60;
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 220 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  scene.add(sun.target);

  return {
    sun,
    hemisphere,
    dispose() {
      scene.remove(sun, sun.target, hemisphere);
      sun.dispose();
      hemisphere.dispose();
    },
  };
}

/** 讓太陽陰影範圍跟著焦點（玩家）移動。以陰影貼圖像素為單位對齊，避免移動時陰影閃爍。 */
export function followShadow(sun: THREE.DirectionalLight, focus: THREE.Vector3, direction: readonly [number, number, number]): void {
  const cam = sun.shadow.camera;
  const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
  const fx = Math.round(focus.x / texel) * texel;
  const fz = Math.round(focus.z / texel) * texel;
  sun.target.position.set(fx, focus.y, fz);
  sun.position.set(fx - direction[0] * 80, focus.y - direction[1] * 80, fz - direction[2] * 80);
  sun.target.updateMatrixWorld();
}
