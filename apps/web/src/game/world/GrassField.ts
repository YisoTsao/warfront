import type { GrassField as GrassFieldData, HeightfieldColliderData } from '@frontline/map-schema';
import * as THREE from 'three';

/**
 * GPU 草地：整片草只有兩次 draw call（近環、遠環），每畫格不需要 CPU 計算。
 *
 * - 每個實例是一叢草（幾片彎曲的草葉），實例只記住自己在格子中的索引；
 *   頂點 shader 把格子「包」在玩家周圍：每一格對應一個固定的世界格，玩家移動時只有邊緣的格子換位置，不會整片跳動。
 * - 世界格的雜湊決定位置抖動、方向、高度與是否有花；密度圖（Blender 的草與花密度，已扣掉道路與水域）
 *   決定這一格有沒有草，沒有就把頂點縮成一點（GPU 直接丟掉退化三角形）。
 * - 地面高度：碰撞高度場做成浮點貼圖，以 texelFetch 做與碰撞相同的三角內插，草根正好貼地。
 * - 顏色：草根取地形底色貼圖（與地面一致），往葉尖變亮、偏黃綠；花在葉尖上色。
 * - 風：大尺度陣風 + 小尺度擺動，越往葉尖擺幅越大；玩家附近的草往外倒。
 * - 遠環的格子比較大、一叢比較寬，近環範圍內的遠環格子丟掉；外緣逐漸變矮，看不到明顯的邊界。
 * 材質用 MeshLambertMaterial 加 onBeforeCompile，霧、陽光、環境光、接收陰影都沿用 three.js 的實作。
 */

export interface GrassQuality {
  /** 近環半徑（公尺），0 表示不畫草 */
  near: number;
  /** 遠環半徑（公尺），不大於近環時不畫遠環 */
  far: number;
}

export const GRASS_QUALITY: Record<'low' | 'medium' | 'high', GrassQuality> = {
  low: { near: 16, far: 0 },
  medium: { near: 22, far: 42 },
  high: { near: 28, far: 60 },
};

const NEAR_CELL = 0.55;
const FAR_CELL = 1.1;
const BLADES_PER_TUFT = 8;
const SEGMENTS = 3;

/** 一叢草的幾何：幾片繞中心分布、往外彎的草葉。attribute `blade`：x = 葉片高度比例（0–1）、y = 葉片索引、z = 左右（−1、1）。 */
function tuftGeometry(): { positions: Float32Array; blade: Float32Array; indices: Uint16Array } {
  const positions: number[] = [];
  const blade: number[] = [];
  const indices: number[] = [];
  for (let b = 0; b < BLADES_PER_TUFT; b++) {
    const base = positions.length / 3;
    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS;
      // 葉片在頂點 shader 裡依索引決定方向與彎曲；這裡只放寬度與高度比例
      const width = 0.5 * (1 - t * 0.85);
      for (const side of [-1, 1]) {
        positions.push(side * width, t, 0);
        blade.push(t, b, side);
      }
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const i = base + s * 2;
      indices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  return { positions: new Float32Array(positions), blade: new Float32Array(blade), indices: new Uint16Array(indices) };
}

/** 格子邊長 n（必為偶數）的實例索引：每個實例一個 (ix, iz)。 */
function gridAttribute(n: number): THREE.InstancedBufferAttribute {
  const data = new Float32Array(n * n * 2);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      data[(iz * n + ix) * 2] = ix;
      data[(iz * n + ix) * 2 + 1] = iz;
    }
  }
  return new THREE.InstancedBufferAttribute(data, 2);
}

const VERTEX_PARS = /* glsl */ `
  attribute vec3 blade;
  attribute vec2 cellIndex;
  uniform float uCell;
  uniform float uGrid;
  uniform float uInner;
  uniform float uOuter;
  uniform float uTuftScale;
  uniform float uTime;
  uniform vec3 uFocus;
  uniform sampler2D uDensity;
  uniform sampler2D uColor;
  uniform float uHasColor;
  uniform vec2 uMapOrigin;
  uniform float uMapSize;
  uniform sampler2D uHeights;
  uniform vec2 uHfOrigin;
  uniform vec2 uHfSize;
  uniform vec2 uHfDims;
  varying vec3 vGrassColor;
  varying float vBladeT;

  float gHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float gNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // 與碰撞高度場（heightfieldHeightAt）相同的三角內插
  float gGround(vec2 xz) {
    vec2 f = (xz - uHfOrigin) / uHfSize * (uHfDims - 1.0);
    f = clamp(f, vec2(0.0), uHfDims - 1.0001);
    vec2 cr = min(floor(f), uHfDims - 2.0);
    vec2 uv = f - cr;
    ivec2 c = ivec2(cr);
    float h00 = texelFetch(uHeights, c, 0).r;
    float h10 = texelFetch(uHeights, c + ivec2(1, 0), 0).r;
    float h01 = texelFetch(uHeights, c + ivec2(0, 1), 0).r;
    float h11 = texelFetch(uHeights, c + ivec2(1, 1), 0).r;
    return uv.x + uv.y <= 1.0
      ? h00 + uv.x * (h10 - h00) + uv.y * (h01 - h00)
      : h11 + (1.0 - uv.x) * (h01 - h11) + (1.0 - uv.y) * (h10 - h11);
  }
`;

const VERTEX_MAIN = /* glsl */ `
  // ---- 格子包在玩家周圍：每個實例固定對應一個世界格 ----
  vec2 baseCell = floor(uFocus.xz / uCell) - uGrid * 0.5;
  vec2 cell = baseCell + mod(cellIndex - baseCell, uGrid);
  float h1 = gHash(cell);
  float h2 = gHash(cell + 17.31);
  float h3 = gHash(cell + 41.7);
  vec2 rootXZ = (cell + 0.15 + 0.7 * vec2(h1, h2)) * uCell;

  vec2 mapUv = (rootXZ - uMapOrigin) / uMapSize;
  vec2 dens = texture2D(uDensity, mapUv).rg;
  float dist = distance(rootXZ, uFocus.xz);
  // 外緣逐漸變矮；近環以內的遠環格子丟掉
  float edge = 1.0 - smoothstep(uOuter * 0.72, uOuter, dist);
  float inner = uInner > 0.0 ? step(uInner, dist) : 1.0;
  // 密度用平方根：稀疏的地方仍有零星的草，比直接比較雜湊自然
  float present = step(h3, sqrt(dens.r) * 1.08) * inner * step(0.0, mapUv.x) * step(mapUv.x, 1.0) * step(0.0, mapUv.y) * step(mapUv.y, 1.0);
  float height = (0.28 + 0.34 * h2 + 0.22 * dens.r) * edge * present;
  float flower = step(gHash(cell + 3.3), dens.g * 2.2) * present;

  // ---- 葉片：繞中心分布、往外彎 ----
  float t = blade.x;
  float angle = blade.y * 2.39996 + h1 * 6.2832;
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 side = vec2(-dir.y, dir.x);
  float spread = (0.03 + 0.22 * gHash(cell + blade.y)) * uTuftScale;
  float bladeHeight = height * (0.65 + 0.5 * gHash(cell + blade.y * 7.1));
  float lean = (0.18 + 0.25 * gHash(cell + blade.y * 3.7)) * bladeHeight;
  vec3 local = vec3(0.0);
  local.xz = dir * (spread + lean * t * t) + side * position.x * 0.065 * uTuftScale * (0.8 + 0.4 * h2);
  local.y = bladeHeight * t;

  // ---- 風與玩家推開 ----
  vec2 windDir = normalize(vec2(0.8, 0.6));
  float gust = gNoise(rootXZ * 0.05 + windDir * uTime * 0.35);
  float sway = sin(uTime * 2.1 + dot(rootXZ, windDir) * 0.45 + h1 * 6.28) * 0.35 + gust * 1.4 - 0.4;
  local.xz += windDir * sway * 0.11 * t * t * bladeHeight * 2.0;
  vec2 away = rootXZ - uFocus.xz;
  float push = (1.0 - smoothstep(0.2, 0.9, length(away))) * step(abs(uFocus.y - gGround(rootXZ)), 1.6);
  local.xz += normalize(away + 1e-4) * push * 0.35 * t * bladeHeight;
  local.y *= 1.0 - push * 0.45;

  vec3 grassPosition = vec3(rootXZ.x, gGround(rootXZ) - 0.03, rootXZ.y) + local;
  // 草葉法線偏向上方：從上方受光，避免薄片的正反面明暗跳動
  vec3 objectNormal = normalize(vec3(dir.x * 0.25, 1.0, dir.y * 0.25));

  // ---- 顏色：草根接近地面，往葉尖變亮；花在葉尖 ----
  vec3 ground = uHasColor > 0.5 ? texture2D(uColor, mapUv).rgb : vec3(0.06, 0.085, 0.03);
  vec3 tipTint = mix(vec3(0.16, 0.2, 0.05), vec3(0.2, 0.17, 0.06), h2 * 0.7);
  vec3 tip = mix(ground * 1.9, tipTint, 0.55);
  vGrassColor = mix(ground * 1.15, tip, t);
  vec3 flowerColor = h1 < 0.4 ? vec3(0.85, 0.82, 0.7) : h1 < 0.75 ? vec3(0.8, 0.6, 0.08) : vec3(0.42, 0.25, 0.6);
  vGrassColor = mix(vGrassColor, flowerColor, flower * step(0.82, t) * step(blade.y, 1.5));
  vBladeT = t;
`;

export class GrassField {
  readonly group = new THREE.Group();
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly textures: THREE.Texture[] = [];
  private readonly tuft = tuftGeometry();
  private rings: Array<THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshLambertMaterial>> = [];
  private quality: GrassQuality | null = null;

  constructor(
    data: GrassFieldData,
    heightfield: HeightfieldColliderData,
    baseUrl: string,
    private readonly scene: THREE.Scene,
  ) {
    const loader = new THREE.TextureLoader();
    const load = (path: string, color: boolean) => {
      const t = loader.load(`${baseUrl}${path}`);
      t.flipY = false;
      t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      this.textures.push(t);
      return t;
    };
    const heights = new THREE.DataTexture(Float32Array.from(heightfield.heights), heightfield.cols, heightfield.rows, THREE.RedFormat, THREE.FloatType);
    heights.minFilter = THREE.NearestFilter;
    heights.magFilter = THREE.NearestFilter;
    heights.needsUpdate = true;
    this.textures.push(heights);

    this.uniforms = {
      uTime: { value: 0 },
      uFocus: { value: new THREE.Vector3() },
      uDensity: { value: load(data.densityMap, false) },
      uColor: { value: data.colorMap ? load(data.colorMap, true) : null },
      uHasColor: { value: data.colorMap ? 1 : 0 },
      uMapOrigin: { value: new THREE.Vector2(...data.origin) },
      uMapSize: { value: data.size },
      uHeights: { value: heights },
      uHfOrigin: { value: new THREE.Vector2(...heightfield.origin) },
      uHfSize: { value: new THREE.Vector2(...heightfield.size) },
      uHfDims: { value: new THREE.Vector2(heightfield.cols, heightfield.rows) },
    };
    this.group.name = 'grass';
    scene.add(this.group);
  }

  /** 改變草地範圍（畫質）；near 為 0 時不畫草。 */
  setQuality(quality: GrassQuality): void {
    if (this.quality && this.quality.near === quality.near && this.quality.far === quality.far) {
      return;
    }
    this.quality = quality;
    for (const ring of this.rings) {
      ring.geometry.dispose();
      ring.material.dispose();
      this.group.remove(ring);
    }
    this.rings = [];
    if (quality.near <= 0) {
      return;
    }
    this.rings.push(this.ring(NEAR_CELL, 0, quality.near, 1));
    if (quality.far > quality.near) {
      this.rings.push(this.ring(FAR_CELL, quality.near, quality.far, 1.6));
    }
  }

  /** 兩個環各用一個材質（同一個 shader program），格子大小等設定是各自的 uniform，其餘共用。 */
  private material(ring: Record<string, THREE.IUniform>): THREE.MeshLambertMaterial {
    const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    material.name = 'frontline-grass';
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, ring);
      // Lambert 的頂點 shader 先處理法線（beginnormal → defaultnormal）再處理位置（begin_vertex），
      // 所以整段草的計算放在 beginnormal_vertex，begin_vertex 只取結果
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
        .replace('#include <beginnormal_vertex>', VERTEX_MAIN)
        .replace('#include <begin_vertex>', 'vec3 transformed = grassPosition;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassColor;\nvarying float vBladeT;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGrassColor;')
        // 草根附近的環境遮蔽
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= 0.45 + 0.55 * vBladeT;');
    };
    material.customProgramCacheKey = () => 'frontline-grass';
    return material;
  }

  private ring(cell: number, inner: number, outer: number, tuftScale: number): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshLambertMaterial> {
    const n = Math.ceil((outer * 2) / cell / 2) * 2;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.tuft.positions, 3));
    geometry.setAttribute('blade', new THREE.BufferAttribute(this.tuft.blade, 3));
    geometry.setIndex(new THREE.BufferAttribute(this.tuft.indices, 1));
    geometry.setAttribute('cellIndex', gridAttribute(n));
    geometry.instanceCount = n * n;
    const material = this.material({
      uCell: { value: cell },
      uGrid: { value: n },
      uInner: { value: inner },
      uOuter: { value: outer },
      uTuftScale: { value: tuftScale },
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = inner > 0 ? 'grass-far' : 'grass-near';
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  update(focus: THREE.Vector3, seconds: number): void {
    this.uniforms.uTime!.value = seconds;
    (this.uniforms.uFocus!.value as THREE.Vector3).copy(focus);
  }

  /** 目前的草叢實例數（除錯用） */
  instanceCount(): number {
    return this.rings.reduce((sum, r) => sum + r.geometry.instanceCount, 0);
  }

  dispose(): void {
    for (const ring of this.rings) {
      ring.geometry.dispose();
      ring.material.dispose();
    }
    this.scene.remove(this.group);
    for (const t of this.textures) {
      t.dispose();
    }
  }
}
