import type { WaterSurface } from '@frontline/map-schema';
import * as THREE from 'three';

/**
 * 水面 shader：
 * - 流動：Blender 水體模擬輸出的流向圖（兩個相位交替的 flowmap 技法），湖面另有風吹的細紋；
 * - 顏色：依水深在淺色（看得到河床）與深色之間吸收，岸邊淡出；
 * - 反射：Fresnel 混合天空（地平線 → 天頂）與太陽高光；
 * - 泡沫：流向圖的泡沫通道、急流與岸邊。
 * 瀑布用另一個模式：沿 UV 往下流的白色水紋。
 */
export interface WaterLighting {
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
  zenith: THREE.Color;
}

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform float uMode;
  uniform float uHasMaps;
  uniform sampler2D uFlow;
  uniform sampler2D uDepth;
  uniform vec2 uOrigin;
  uniform float uSize;
  uniform float uMaxDepth;
  uniform float uMaxSpeed;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  varying vec3 vWorld;
  varying vec2 vUv;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  // 幾組方向不同的正弦波，回傳高度對 x、z 的偏導數
  vec2 waveSlope(vec2 p, float t) {
    vec2 d = vec2(0.0);
    const int N = 5;
    for (int i = 0; i < N; i++) {
      float fi = float(i);
      float angle = fi * 2.399 + 0.6;
      vec2 dir = vec2(cos(angle), sin(angle));
      float freq = 1.3 * pow(1.55, fi);
      float amp = 0.055 / pow(1.6, fi);
      float phase = dot(dir, p) * freq + t * (0.8 + fi * 0.35);
      d += dir * cos(phase) * freq * amp;
    }
    return d;
  }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorld);

    if (uMode > 0.5) {
      // ---- 瀑布 ----
      float streak = noise(vec2(vUv.x * 40.0, vUv.y * 6.0 + uTime * 2.4)) * 0.6 + noise(vec2(vUv.x * 90.0, vUv.y * 14.0 + uTime * 3.7)) * 0.4;
      float lightAmount = 0.55 + 0.45 * max(uSunDir.y, 0.0);
      vec3 color = mix(vec3(0.45, 0.55, 0.55), vec3(0.95), smoothstep(0.35, 0.8, streak)) * (uHorizon * 0.6 + uSunColor * 0.5) * lightAmount;
      gl_FragColor = vec4(color, 0.55 + 0.4 * smoothstep(0.3, 0.75, streak));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
      return;
    }

    vec2 mapUv = (vWorld.xz - uOrigin) / uSize;
    vec3 flowSample = uHasMaps > 0.5 ? texture2D(uFlow, mapUv).rgb : vec3(0.5, 0.5, 0.0);
    vec2 flow = flowSample.rg * 2.0 - 1.0;
    float speed = flowSample.b * uMaxSpeed;
    vec2 depthSample = uHasMaps > 0.5 ? texture2D(uDepth, mapUv).rg : vec2(0.4, 0.0);
    float depth = depthSample.r * uMaxDepth;
    float foamMap = depthSample.g;

    // 兩個相位交替：每個相位把波紋沿流向推移，切換時權重為 0，看不到跳動
    float cycle = 3.0;
    float t = uTime / cycle;
    float ph0 = fract(t);
    float ph1 = fract(t + 0.5);
    float w = abs(ph0 - 0.5) * 2.0;
    vec2 move = flow * speed * cycle;
    vec2 p = vWorld.xz;
    vec2 s0 = waveSlope(p * 0.55 - move * ph0 * 0.55, uTime * 0.6);
    vec2 s1 = waveSlope(p * 0.55 - move * ph1 * 0.55 + 17.3, uTime * 0.6);
    vec2 slope = mix(s0, s1, w);
    // 湖面與緩流處的風吹細紋
    slope += waveSlope(p * 2.1 + vec2(uTime * 0.35, uTime * 0.2), uTime * 1.7) * 0.35;
    // 急流處水面更亂；遠處減弱，避免高頻波紋在遠景閃爍
    float dist = length(cameraPosition - vWorld);
    slope *= (0.8 + clamp(speed, 0.0, 2.0) * 0.9) * mix(1.0, 0.2, smoothstep(15.0, 110.0, dist));
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

    float cosTheta = max(dot(n, viewDir), 0.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
    vec3 reflDir = reflect(-viewDir, n);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, reflDir.y)) * 0.85;
    float spec = pow(max(dot(reflDir, uSunDir), 0.0), 600.0) * 6.0 + pow(max(dot(reflDir, uSunDir), 0.0), 60.0) * 0.25;

    // 水體：深度越深吸收越多，淺處看得到偏黃綠的河床
    float absorb = 1.0 - exp(-depth * 0.85);
    float light = 0.35 + 0.65 * max(uSunDir.y, 0.0);
    vec3 body = mix(uShallow, uDeep, absorb) * (uHorizon * 0.7 + uSunColor * 0.45) * light;
    vec3 color = mix(body, sky, fresnel) + uSunColor * spec;

    // 泡沫：流向圖的泡沫、急流、岸邊淺水；用沿流向移動的雜訊打碎
    vec2 foamP = p * 1.6 - flow * speed * uTime * 1.2;
    float foamNoise = noise(foamP) * 0.6 + noise(foamP * 2.7 + 5.1) * 0.4;
    // 急流處是條紋狀的白水，不是整片白色
    float foamAmount = clamp(foamMap * 0.9 + smoothstep(1.1, 1.7, speed) * 0.35 + (1.0 - smoothstep(0.03, 0.15, depth)) * 0.3, 0.0, 0.8);
    float streaks = noise(vec2(dot(p, normalize(flow + 1e-4)) * 0.6, dot(p, vec2(-flow.y, flow.x)) * 3.5) - vec2(speed * uTime * 0.8, 0.0));
    foamAmount *= smoothstep(0.55, 0.85, foamNoise * 0.6 + streaks * 0.4 + foamAmount * 0.25);
    color = mix(color, vec3(0.85, 0.88, 0.86) * (uHorizon * 0.5 + uSunColor * 0.55) * light, foamAmount * 0.7);

    float alpha = mix(0.45, 0.93, absorb) + fresnel * 0.35 + foamAmount * 0.5;
    // 岸邊淡出，避免水面與地形交界的硬邊
    alpha *= smoothstep(0.0, 0.1, depth);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export class WaterMaterials {
  private readonly uniforms: Record<string, THREE.IUniform>;
  readonly water: THREE.ShaderMaterial;
  readonly waterfall: THREE.ShaderMaterial;
  private readonly textures: THREE.Texture[] = [];

  constructor(lighting: WaterLighting, surface: WaterSurface | undefined, baseUrl: string) {
    const loader = new THREE.TextureLoader();
    const load = (path: string, color: boolean) => {
      const t = loader.load(`${baseUrl}${path}`);
      t.flipY = false;
      t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.userData.shared = true;
      this.textures.push(t);
      return t;
    };
    const flow = surface ? load(surface.flowMap, false) : null;
    const depth = surface ? load(surface.depthMap, false) : null;
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uMode: { value: 0 },
      uHasMaps: { value: surface ? 1 : 0 },
      uFlow: { value: flow },
      uDepth: { value: depth },
      uOrigin: { value: new THREE.Vector2(...(surface?.origin ?? [0, 0])) },
      uSize: { value: surface?.size ?? 1 },
      uMaxDepth: { value: surface?.maxDepth ?? 1 },
      uMaxSpeed: { value: surface?.maxSpeed ?? 1 },
      uSunDir: { value: lighting.sunDirection.clone().normalize() },
      uSunColor: { value: lighting.sunColor.clone() },
      uHorizon: { value: lighting.horizon.clone() },
      uZenith: { value: lighting.zenith.clone() },
      uShallow: { value: new THREE.Color(0.11, 0.13, 0.08) },
      uDeep: { value: new THREE.Color(0.012, 0.035, 0.035) },
    };
    const make = (mode: number, side: THREE.Side) => {
      const material = new THREE.ShaderMaterial({
        name: mode ? 'frontline-waterfall' : 'frontline-water',
        vertexShader,
        fragmentShader,
        uniforms: { ...this.uniforms, uMode: { value: mode } },
        transparent: true,
        depthWrite: false,
        fog: true,
        side,
      });
      material.userData.shared = true;
      return material;
    };
    this.water = make(0, THREE.FrontSide);
    this.waterfall = make(1, THREE.DoubleSide);
  }

  update(seconds: number): void {
    this.uniforms.uTime!.value = seconds;
  }

  /** 依 glTF 材質的 extras.frontline_shader 換成水面材質；回傳是否有替換。 */
  apply(mesh: THREE.Mesh): boolean {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const kind = material?.userData.frontline_shader;
    if (kind !== 'water' && kind !== 'waterfall') {
      return false;
    }
    material!.dispose();
    mesh.material = kind === 'water' ? this.water : this.waterfall;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.castShadow = false;
    mesh.renderOrder = 1;
    return true;
  }

  dispose(): void {
    this.water.dispose();
    this.waterfall.dispose();
    for (const t of this.textures) {
      t.dispose();
    }
  }
}
