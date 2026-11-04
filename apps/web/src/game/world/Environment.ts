import type { MapEnvironment } from '@frontline/map-schema';
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export interface EnvironmentHandles {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  /** 天空在地平線附近的平均顏色（線性，已依亮度校正），霧與水面反射使用 */
  horizonColor: THREE.Color;
  /** 天頂顏色（線性，已依亮度校正），水面反射使用 */
  zenithColor: THREE.Color;
  dispose(): void;
}

/**
 * 依地圖 manifest 設定天空、霧與光源：
 * - 物理天空（Rayleigh／Mie 散射）畫進立方體貼圖，當作背景與 PMREM 環境貼圖，太陽位置與地圖的太陽方向一致；
 * - 天空的原始亮度很高（為了 HDR），以地圖設定的霧色亮度為目標算出縮放倍率，
 *   背景、環境光、霧與水面反射都用同一個倍率，整體不會過曝；
 * - 霧的顏色取天空地平線附近的平均色，遠景與天空自然銜接。
 * 太陽陰影跟著玩家移動，只涵蓋附近範圍。
 */
export function applyEnvironment(scene: THREE.Scene, env: MapEnvironment, renderer: THREE.WebGLRenderer): EnvironmentHandles {
  const [dx, dy, dz] = env.sunDirection;
  const toSun = new THREE.Vector3(-dx, -dy, -dz).normalize();

  const sky = new Sky();
  sky.scale.setScalar(100);
  const u = sky.material.uniforms;
  u.turbidity!.value = 5.5;
  u.rayleigh!.value = 1.4;
  u.mieCoefficient!.value = 0.004;
  u.mieDirectionalG!.value = 0.8;
  u.sunPosition!.value.copy(toSun);
  const skyScene = new THREE.Scene();
  skyScene.add(sky);

  const cube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const previous = renderer.getRenderTarget();
  new THREE.CubeCamera(0.1, 500, cube).update(renderer, skyScene);
  renderer.setRenderTarget(previous);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromCubemap(cube.texture);
  pmrem.dispose();
  const measured = measureSky(renderer, skyScene);
  sky.geometry.dispose();
  sky.material.dispose();

  // 亮度校正：地平線亮度對齊地圖設定的霧色
  const targetFog = new THREE.Color(env.fogColor);
  const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const scale = THREE.MathUtils.clamp(luminance(targetFog) / Math.max(luminance(measured.horizon), 1e-4), 0.02, 4);
  const horizon = measured.horizon.multiplyScalar(scale);
  const zenith = measured.zenith.multiplyScalar(scale);

  scene.background = cube.texture;
  scene.backgroundIntensity = scale;
  scene.environment = envTarget.texture;
  scene.environmentIntensity = scale * 0.85;
  // 霧用天空的地平線顏色，稍微往地圖設定的霧色靠，保留地圖作者的意圖
  scene.fog = new THREE.Fog(horizon.clone().lerp(targetFog, 0.3), env.fogNear, env.fogFar);

  const hemisphere = new THREE.HemisphereLight(env.hemisphereSky, env.hemisphereGround, env.hemisphereIntensity * 0.4);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  sun.position.copy(toSun).multiplyScalar(80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const extent = 70;
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 240 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  return {
    sun,
    hemisphere,
    horizonColor: horizon,
    zenithColor: zenith,
    dispose() {
      scene.remove(sun, sun.target, hemisphere);
      if (scene.environment === envTarget.texture) {
        scene.environment = null;
      }
      if (scene.background === cube.texture) {
        scene.background = null;
      }
      envTarget.dispose();
      cube.dispose();
      sun.dispose();
      hemisphere.dispose();
    },
  };
}

/** 把天空畫進小的立方體貼圖，取四個水平面中間偏下的平均色（地平線）與上方面的平均色（天頂）。 */
function measureSky(renderer: THREE.WebGLRenderer, skyScene: THREE.Scene): { horizon: THREE.Color; zenith: THREE.Color } {
  const size = 16;
  const target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType });
  const camera = new THREE.CubeCamera(0.1, 200, target);
  const previous = renderer.getRenderTarget();
  camera.update(renderer, skyScene);
  const pixels = new Uint16Array(size * size * 4);
  const horizon = new THREE.Color(0, 0, 0);
  const zenith = new THREE.Color(0, 0, 0);
  // 立方體面順序：+X、−X、+Y、−Y、+Z、−Z
  for (const face of [0, 1, 2, 4, 5]) {
    try {
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels, face);
    } catch {
      continue;
    }
    const rows = face === 2 ? [0, size] : [Math.floor(size * 0.45), Math.floor(size * 0.6)];
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = rows[0]!; y < rows[1]!; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        r += THREE.DataUtils.fromHalfFloat(pixels[i]!);
        g += THREE.DataUtils.fromHalfFloat(pixels[i + 1]!);
        b += THREE.DataUtils.fromHalfFloat(pixels[i + 2]!);
        n++;
      }
    }
    const c = new THREE.Color(r / n, g / n, b / n);
    if (face === 2) {
      zenith.copy(c);
    } else {
      horizon.add(c.multiplyScalar(0.25));
    }
  }
  renderer.setRenderTarget(previous);
  target.dispose();
  // 讀不到（例如某些驅動不支援半浮點讀取）時用合理的預設值
  if (!(horizon.r + horizon.g + horizon.b > 0.01)) {
    horizon.setRGB(0.55, 0.62, 0.72);
  }
  if (!(zenith.r + zenith.g + zenith.b > 0.01)) {
    zenith.setRGB(0.18, 0.32, 0.62);
  }
  return { horizon, zenith };
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
