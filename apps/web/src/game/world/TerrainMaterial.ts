import type { TerrainSurface, WaterSurface } from '@frontline/map-schema';
import * as THREE from 'three';

/**
 * 地形 shader（材質 extras.frontline_shader = 'terrain'）：
 *
 * - 六種掃描貼圖（草地、林地落葉、岩石、泥土路面、碎石、河岸泥地）依 manifest.terrain 的圖層權重混合；
 *   顏色與法線各放在一張 sampler2DArray（每層 512²，載入時解碼），只取權重夠大的圖層。
 * - 圖層邊界用貼圖亮度當「高度」做高度混合：碎石從草縫裡露出來，而不是兩張圖淡入淡出。
 * - 防重複：每層取兩次（不同縮放與旋轉），以大尺度雜訊混合；遠處再淡回地形底色。
 * - 顏色：細節貼圖 ×（底色 / 圖層平均色），大範圍的顏色仍由 Blender 植被密度畫成的底色決定。
 * - 岩石用三向投影（陡坡、崖面不會被拉長）。
 * - 路面：依路面橫向座標畫兩道車轍（壓暗、法線凹陷），積水處變暗、變光滑並反射天空。
 * - 水底：依水深圖疊上會動的焦散光紋。
 * 其餘（陽光、陰影、霧、環境光）沿用 MeshStandardMaterial。
 */

const LAYER_SIZE = 512;

const VERTEX_PARS = /* glsl */ `
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;
`;

const VERTEX_MAIN = /* glsl */ `
  vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const FRAGMENT_PARS = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2D uSplat;
  uniform sampler2D uSplat2;
  uniform sampler2D uAcross;
  uniform sampler2DArray uAlbedo;
  uniform sampler2DArray uNormal;
  uniform float uTile[6];
  uniform vec3 uMean[6];
  uniform vec2 uOrigin;
  uniform float uSize;
  uniform float uDetailFar;
  uniform sampler2D uWaterDepth;
  uniform vec2 uWaterOrigin;
  uniform float uWaterSize;
  uniform float uWaterMaxDepth;
  uniform float uTime;
  varying vec3 vTerrainPos;
  varying vec3 vTerrainNormal;

  float tHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float tNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // 兩組不同縮放與旋轉的取樣，依雜訊混合，打散重複的格子感
  const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);
  vec4 sampleLayer(sampler2DArray tex, vec2 uv, float layer, float mixer) {
    vec4 a = texture(tex, vec3(uv, layer));
    vec4 b = texture(tex, vec3(ROT * uv * 0.71 + 0.37, layer));
    return mix(a, b, mixer);
  }
  // 平面投影（uv = (x, −z) / tile）的切線空間法線轉成世界空間
  vec3 planarNormal(vec3 tn, vec3 N) {
    vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
    vec3 B = cross(N, T);
    return normalize(T * tn.x + B * tn.y + N * tn.z);
  }
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  // 焦散：兩層扭曲的格狀雜訊取最小值
  float caustic(vec2 p, float t) {
    vec2 q = p + vec2(sin(p.y * 1.7 + t * 1.3), cos(p.x * 1.9 - t * 1.1)) * 0.35;
    vec2 f = fract(q) - 0.5;
    float a = 1.0 - smoothstep(0.0, 0.35, abs(length(f) - 0.32));
    vec2 q2 = ROT * p * 1.37 + vec2(t * 0.4, -t * 0.3);
    vec2 f2 = fract(q2 + vec2(sin(q2.y * 2.1 + t), cos(q2.x * 1.6 - t)) * 0.3) - 0.5;
    float b = 1.0 - smoothstep(0.0, 0.35, abs(length(f2) - 0.3));
    return a * b;
  }
`;

const MAP_FRAGMENT = /* glsl */ `
  vec3 terrainN = normalize(vTerrainNormal);
  float terrainRough = 0.95;
  {
    vec3 macro = texture2D(map, vMapUv).rgb;
    vec2 suv = (vTerrainPos.xz - uOrigin) / uSize;
    vec3 s1 = texture2D(uSplat, suv).rgb;
    vec3 s2 = texture2D(uSplat2, suv).rgb;
    float w[6];
    w[1] = s1.r; w[2] = s1.g; w[3] = s1.b; w[4] = s2.r; w[5] = s2.g;
    w[0] = max(0.0, 1.0 - (w[1] + w[2] + w[3] + w[4] + w[5]));
    float puddle = s2.b;
    float dist = distance(cameraPosition, vTerrainPos);
    float fade = 1.0 - smoothstep(uDetailFar * 0.45, uDetailFar, dist);
    vec3 N = terrainN;
    // 車轍高度的梯度（螢幕空間導數必須在分支外計算）
    float across = texture2D(uAcross, suv).r * 2.0 - 1.0;
    float rutJitter = (tNoise(vTerrainPos.xz / 3.0) - 0.5) * 0.12;
    float rut = exp(-pow((abs(across) - 0.42 - rutJitter) / 0.11, 2.0)) * smoothstep(0.05, 0.4, w[3]);
    float rh = -rut * 0.08;
    vec3 dpdx = dFdx(vTerrainPos);
    vec3 dpdy = dFdy(vTerrainPos);
    float dhx = dFdx(rh);
    float dhy = dFdy(rh);
    vec3 albedo = vec3(0.0);
    vec3 mean = vec3(0.0);
    vec3 nrm = vec3(0.0);
    float total = 0.0;
    if (fade > 0.0) {
      float mixer = smoothstep(0.3, 0.7, tNoise(vTerrainPos.xz / 11.0));
      // 高度混合：權重加上貼圖亮度（當作高度），只保留接近最高者的圖層
      vec4 col[6];
      float h[6];
      float hmax = 0.0;
      for (int i = 0; i < 6; i++) {
        col[i] = vec4(0.0);
        h[i] = -1.0;
        if (w[i] < 0.02) continue;
        vec2 uv = vec2(vTerrainPos.x, -vTerrainPos.z) / uTile[i];
        if (i == 2) {
          // 岩石：三向投影
          vec3 bw = pow(abs(N), vec3(4.0));
          bw /= bw.x + bw.y + bw.z;
          vec3 p = vTerrainPos / uTile[i];
          col[i] = texture(uAlbedo, vec3(p.zy, 2.0)) * bw.x + texture(uAlbedo, vec3(p.xz * vec2(1.0, -1.0), 2.0)) * bw.y + texture(uAlbedo, vec3(p.xy, 2.0)) * bw.z;
        } else {
          col[i] = sampleLayer(uAlbedo, uv, float(i), mixer);
        }
        // 貼圖陣列存的是 sRGB 值（不經硬體解碼），在這裡轉成線性
        col[i].rgb = pow(col[i].rgb, vec3(2.2));
        h[i] = w[i] + luma(col[i].rgb) * 0.6;
        hmax = max(hmax, h[i]);
      }
      for (int i = 0; i < 6; i++) {
        float b = max(h[i] - (hmax - 0.25), 0.0);
        if (b <= 0.0) continue;
        vec3 tn;
        vec3 wn;
        if (i == 2) {
          vec3 bw = pow(abs(N), vec3(4.0));
          bw /= bw.x + bw.y + bw.z;
          vec3 p = vTerrainPos / uTile[i];
          vec3 nx = texture(uNormal, vec3(p.zy, 2.0)).xyz * 2.0 - 1.0;
          vec3 ny = texture(uNormal, vec3(p.xz * vec2(1.0, -1.0), 2.0)).xyz * 2.0 - 1.0;
          vec3 nz = texture(uNormal, vec3(p.xy, 2.0)).xyz * 2.0 - 1.0;
          // whiteout 混合
          nx = vec3(nx.xy + N.zy, abs(nx.z) * N.x);
          ny = vec3(ny.xy + N.xz, abs(ny.z) * N.y);
          nz = vec3(nz.xy + N.xy, abs(nz.z) * N.z);
          wn = normalize(nx.zyx * bw.x + ny.xzy * bw.y + nz.xyz * bw.z);
        } else {
          vec2 uv = vec2(vTerrainPos.x, -vTerrainPos.z) / uTile[i];
          tn = sampleLayer(uNormal, uv, float(i), mixer).xyz * 2.0 - 1.0;
          wn = planarNormal(tn, N);
        }
        albedo += col[i].rgb * b;
        mean += uMean[i] * b;
        nrm += wn * b;
        total += b;
      }
      albedo /= total;
      mean /= total;
      // 細節 ×（底色 / 圖層平均色）：保留底色的大範圍變化
      vec3 tint = clamp(macro / max(mean, vec3(0.004)), vec3(0.08), vec3(3.0));
      vec3 detailed = albedo * tint;
      // ---- 路面：車轍與積水 ----
      float roadW = w[3];
      if (roadW > 0.05) {
        detailed *= 1.0 - 0.28 * rut;
        // 凹陷：車轍高度的梯度轉成法線擾動
        vec3 r1 = cross(dpdy, N);
        vec3 r2 = cross(N, dpdx);
        float det = dot(dpdx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        nrm = normalize(normalize(nrm) * abs(det) - grad * 2.0);
        // 積水：越中央越深；水面平滑、顏色暗
        float wet = smoothstep(0.1, 0.6, puddle) * roadW;
        detailed *= mix(1.0, 0.45, wet);
        nrm = normalize(mix(nrm, N, wet));
        terrainRough = mix(terrainRough, 0.06, wet);
        float damp = smoothstep(0.0, 0.25, puddle) * roadW;
        detailed *= mix(1.0, 0.8, damp);
        terrainRough = mix(terrainRough, 0.55, damp * (1.0 - wet));
      }
      macro = mix(macro, detailed, fade);
      terrainN = normalize(mix(N, normalize(nrm), fade));
    }
    // ---- 水底焦散 ----
    if (uWaterSize > 0.0) {
      vec2 wuv = (vTerrainPos.xz - uWaterOrigin) / uWaterSize;
      float depth = texture2D(uWaterDepth, wuv).r * uWaterMaxDepth;
      if (depth > 0.02) {
        float c = caustic(vTerrainPos.xz * 0.9, uTime * 0.9);
        float k = smoothstep(0.02, 0.25, depth) * (1.0 - smoothstep(1.0, 3.5, depth));
        macro *= mix(vec3(1.0), vec3(0.55, 0.75, 0.72), smoothstep(0.0, 2.5, depth));
        macro += vec3(0.5, 0.62, 0.58) * c * k * 0.35;
        terrainRough = mix(terrainRough, 0.4, smoothstep(0.0, 0.2, depth));
      }
    }
    diffuseColor.rgb *= macro;
  }
`;

const NORMAL_FRAGMENT = /* glsl */ `
  normal = normalize((viewMatrix * vec4(terrainN, 0.0)).xyz);
`;

const ROUGHNESS_FRAGMENT = /* glsl */ `
  float roughnessFactor = terrainRough;
`;

interface DecodedLayer {
  pixels: Uint8ClampedArray;
  /** 線性色彩的平均（色調換算用） */
  mean: THREE.Vector3;
}

async function decode(url: string, srgb: boolean): Promise<DecodedLayer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`無法下載地形貼圖 ${url}（HTTP ${response.status}）`);
  }
  const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'none', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(LAYER_SIZE, LAYER_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, LAYER_SIZE, LAYER_SIZE);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, LAYER_SIZE, LAYER_SIZE).data;
  const mean = new THREE.Vector3();
  if (srgb) {
    const toLinear = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    let n = 0;
    for (let i = 0; i < pixels.length; i += 4 * 16) {
      mean.x += toLinear(pixels[i]!);
      mean.y += toLinear(pixels[i + 1]!);
      mean.z += toLinear(pixels[i + 2]!);
      n++;
    }
    mean.divideScalar(n);
  }
  return { pixels, mean };
}

function arrayTexture(layers: DecodedLayer[], anisotropy: number): THREE.DataArrayTexture {
  const data = new Uint8Array(LAYER_SIZE * LAYER_SIZE * 4 * layers.length);
  layers.forEach((l, i) => data.set(l.pixels, i * LAYER_SIZE * LAYER_SIZE * 4));
  const texture = new THREE.DataArrayTexture(data, LAYER_SIZE, LAYER_SIZE, layers.length);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  // 貼圖陣列一律不標色彩空間（不是每個版本都會替陣列選 sRGB 內部格式）；顏色在 shader 裡轉成線性
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 依 manifest.terrain 建立地形材質；沒有地形資料時 apply 一律不處理。 */
export class TerrainMaterials {
  private material: THREE.MeshStandardMaterial | null = null;
  private readonly textures: THREE.Texture[] = [];
  private readonly uniforms: Record<string, THREE.IUniform>;

  private constructor(
    private readonly surface: TerrainSurface | undefined,
    uniforms: Record<string, THREE.IUniform>,
    textures: THREE.Texture[],
  ) {
    this.uniforms = uniforms;
    this.textures.push(...textures);
  }

  static async load(surface: TerrainSurface | undefined, water: WaterSurface | undefined, baseUrl: string, renderer: THREE.WebGLRenderer): Promise<TerrainMaterials> {
    if (!surface) {
      return new TerrainMaterials(undefined, {}, []);
    }
    const url = (path: string) => `${baseUrl}${path}`;
    const loader = new THREE.TextureLoader();
    const map = async (path: string) => {
      const t = await loader.loadAsync(url(path));
      t.flipY = false;
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    };
    const [splat, splat2, across, albedo, normal, depth] = await Promise.all([
      map(surface.splatMap),
      map(surface.splat2Map),
      map(surface.acrossMap),
      Promise.all(surface.layers.map((l) => decode(url(l.albedo), true))),
      Promise.all(surface.layers.map((l) => decode(url(l.normal), false))),
      water ? map(water.depthMap) : Promise.resolve(null),
    ]);
    // 橫向座標不能用 mipmap：遠處把兩側路肩的 −1、1 平均成 0，會在路中央畫出假車轍
    across.minFilter = THREE.LinearFilter;
    across.generateMipmaps = false;
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const albedoArray = arrayTexture(albedo, anisotropy);
    const normalArray = arrayTexture(normal, anisotropy);
    const uniforms: Record<string, THREE.IUniform> = {
      uSplat: { value: splat },
      uSplat2: { value: splat2 },
      uAcross: { value: across },
      uAlbedo: { value: albedoArray },
      uNormal: { value: normalArray },
      uTile: { value: surface.layers.map((l) => l.tile) },
      uMean: { value: albedo.map((l) => l.mean) },
      uOrigin: { value: new THREE.Vector2(...surface.origin) },
      uSize: { value: surface.size },
      uDetailFar: { value: 260 },
      uWaterDepth: { value: depth },
      uWaterOrigin: { value: new THREE.Vector2(...(water?.origin ?? [0, 0])) },
      uWaterSize: { value: depth && water ? water.size : 0 },
      uWaterMaxDepth: { value: water?.maxDepth ?? 1 },
      uTime: { value: 0 },
    };
    return new TerrainMaterials(surface, uniforms, [splat, splat2, across, albedoArray, normalArray, ...(depth ? [depth] : [])]);
  }

  /** 換掉地形分塊的材質；回傳是否已處理。所有地形分塊共用同一個材質。 */
  apply(mesh: THREE.Mesh): boolean {
    const original = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
    if (!this.surface || original?.userData.frontline_shader !== 'terrain') {
      return false;
    }
    if (!this.material) {
      const material = new THREE.MeshStandardMaterial({ map: original.map, roughness: 0.95, metalness: 0 });
      material.userData.shared = true;
      if (original.map) {
        original.map.userData.shared = true;
      }
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
          .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
          .replace('#include <map_fragment>', MAP_FRAGMENT)
          .replace('#include <roughnessmap_fragment>', ROUGHNESS_FRAGMENT)
          .replace('#include <normal_fragment_maps>', NORMAL_FRAGMENT);
      };
      material.customProgramCacheKey = () => 'frontline-terrain';
      this.material = material;
    }
    if (original && original !== this.material) {
      original.dispose();
    }
    mesh.material = this.material;
    return true;
  }

  update(time: number): void {
    if (this.uniforms.uTime) {
      this.uniforms.uTime.value = time;
    }
  }

  /** 細節貼圖淡回底色的距離（公尺）；低畫質縮短 */
  setDetailDistance(meters: number): void {
    if (this.uniforms.uDetailFar) {
      this.uniforms.uDetailFar.value = meters;
    }
  }

  dispose(): void {
    this.material?.dispose();
    for (const t of this.textures) {
      t.dispose();
    }
  }
}
