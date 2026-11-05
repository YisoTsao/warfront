import type { WaterSurface } from '@frontline/map-schema';
import * as THREE from 'three';

/**
 * 水面 shader：
 * - 倒影：平面反射——場景沿水面鏡射後以較低解析度畫進貼圖（樹、岸、雲、士兵都看得到），
 *   依波紋法線扭曲取樣；離鏡射平面太遠（例如上游較高的河段）或沒有反射貼圖時，改用天空的解析式顏色；
 * - 波動：流向圖推動的多層雜訊法線（兩個相位交替的 flowmap 技法），越急越亂；另有風吹的細小漣漪；
 *   遠處的高頻法線依距離減弱，避免閃爍；
 * - 光：Fresnel（Schlick）混合水體顏色與倒影；陽光用 GGX 鏡面反射，粗糙度隨波紋與距離增加，會出現閃爍的光點；
 * - 顏色：依水深在淺色（看得到河床）與深色之間吸收，淺處更透明，岸邊淡出；
 * - 泡沫：流向圖的泡沫通道、急流與岸邊，用沿流向移動的雜訊打碎成條紋。
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
  uniform mat4 uReflectionMatrix;
  varying vec3 vWorld;
  varying vec2 vUv;
  varying vec4 vReflection;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vReflection = uReflectionMatrix * world;
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
  uniform sampler2D uReflection;
  uniform float uReflectionOn;
  uniform float uReflectionPlane;
  uniform float uUnder;
  varying vec3 vWorld;
  varying vec2 vUv;
  varying vec4 vReflection;

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
  // 值雜訊與解析梯度（x、y = 偏導數，z = 值）
  vec3 noiseD(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return vec3(du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx), a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y);
  }
  // 多層雜訊水面的斜率：每層旋轉、頻率加倍、振幅減半，lod 越大高頻越弱
  vec2 surfaceSlope(vec2 p, float t, float detail) {
    vec2 slope = vec2(0.0);
    float amp = 0.16;
    float freq = 0.9;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      vec3 n = noiseD(p * freq + vec2(t * (0.25 + fi * 0.13), -t * (0.18 + fi * 0.07)) + fi * 7.31);
      slope += n.xy * amp * freq * (i >= 3 ? detail : 1.0);
      p = rot * p;
      freq *= 2.03;
      amp *= 0.5;
    }
    return slope * 0.35;
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

    if (!gl_FrontFacing) {
      // ---- 從水下往上看水面：正上方是透出天空的「斯涅爾窗」，斜看是全反射的暗綠水色 ----
      float up = clamp(-viewDir.y, 0.0, 1.0);
      float window = smoothstep(0.62, 0.78, up);
      float ripple = noise(vWorld.xz * 1.3 + uTime * vec2(0.6, 0.4)) * 0.5 + noise(vWorld.xz * 3.1 - uTime * vec2(0.3, 0.7)) * 0.5;
      vec3 sky = mix(uHorizon, uZenith, 0.5) * 1.1 + uSunColor * 0.25 * smoothstep(0.55, 0.9, ripple);
      vec3 color = mix(vec3(0.025, 0.09, 0.085), sky, window * (0.75 + 0.25 * ripple));
      gl_FragColor = vec4(color, 0.92);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    vec2 mapUv = (vWorld.xz - uOrigin) / uSize;
    vec3 flowSample = uHasMaps > 0.5 ? texture2D(uFlow, mapUv).rgb : vec3(0.5, 0.5, 0.0);
    vec2 flow = flowSample.rg * 2.0 - 1.0;
    float speed = flowSample.b * uMaxSpeed;
    vec2 depthSample = uHasMaps > 0.5 ? texture2D(uDepth, mapUv).rg : vec2(0.4, 0.0);
    float depth = depthSample.r * uMaxDepth;
    float foamMap = depthSample.g;
    float dist = length(cameraPosition - vWorld);
    // 遠處高頻法線減弱：0 = 近處完整細節，1 = 遠處只剩大波
    float far = smoothstep(12.0, 90.0, dist);

    // ---- 波動：兩個相位交替，每個相位把波紋沿流向推移，切換時權重為 0，看不到跳動 ----
    float cycle = 2.0;
    float t = uTime / cycle;
    float ph0 = fract(t);
    float ph1 = fract(t + 0.5);
    float w = abs(ph0 - 0.5) * 2.0;
    vec2 move = flow * speed * cycle;
    vec2 p = vWorld.xz;
    vec2 s0 = surfaceSlope(p * 0.7 - move * ph0 * 0.7, uTime * 0.5, 1.0 - far);
    vec2 s1 = surfaceSlope(p * 0.7 - move * ph1 * 0.7 + 17.3, uTime * 0.5, 1.0 - far);
    vec2 slope = mix(s0, s1, w);
    // 風吹的細小漣漪（靜水處最明顯）
    slope += surfaceSlope(p * 3.2 + vec2(uTime * 0.6, uTime * 0.35), uTime * 1.6, 1.0 - far) * 0.35 * (1.0 - far);
    // 急流處水面更亂
    slope *= 0.7 + clamp(speed, 0.0, 2.5) * 0.75;
    slope *= mix(1.0, 0.35, far);
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

    // ---- 倒影 ----
    float cosTheta = max(dot(n, viewDir), 0.0);
    // Schlick：水的 F0 約 0.02
    float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);
    vec3 reflDir = reflect(-viewDir, n);
    reflDir.y = abs(reflDir.y);
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, reflDir.y)) * 0.9;
    vec3 reflection = sky;
    if (uReflectionOn > 0.5) {
      // 依法線把取樣位置往旁邊推：越近、波越大，倒影越碎
      vec2 distortion = n.xz * (0.035 + 0.06 * clamp(speed, 0.0, 2.0)) / max(1.0, dist * 0.04);
      vec2 uv = vReflection.xy / vReflection.w + distortion;
      vec3 mirrored = texture2D(uReflection, clamp(uv, vec2(0.002), vec2(0.998))).rgb;
      // 離鏡射平面太遠的水面（高度差超過約 1.5 m）倒影位置不對，改用天空
      float valid = 1.0 - smoothstep(0.6, 1.6, abs(vWorld.y - uReflectionPlane));
      reflection = mix(sky, mirrored, valid);
    }

    // ---- 陽光：GGX 鏡面反射（粗糙度隨距離增加，遠處的高光變寬而不閃爍） ----
    vec3 h = normalize(viewDir + uSunDir);
    float nh = max(dot(n, h), 0.0);
    float nl = max(dot(n, uSunDir), 0.0);
    float roughness = mix(0.06, 0.2, far) + clamp(speed, 0.0, 2.0) * 0.04;
    float a2 = roughness * roughness * roughness * roughness;
    float dTerm = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
    float hv = max(dot(h, viewDir), 0.0);
    float fSun = 0.02 + 0.98 * pow(1.0 - hv, 5.0);
    vec3 sunSpec = uSunColor * dTerm * fSun * nl * 0.25;

    // ---- 水體：深度越深吸收越多，淺處看得到偏黃綠的河床 ----
    float absorb = 1.0 - exp(-depth * 0.9);
    float light = 0.35 + 0.65 * max(uSunDir.y, 0.0);
    vec3 body = mix(uShallow, uDeep, absorb) * (uHorizon * 0.7 + uSunColor * 0.45) * light;
    // 往下看時水比較透（多看到河床、少看到倒影），斜看時幾乎全是倒影
    vec3 color = mix(body, reflection, fresnel) + sunSpec;

    // ---- 泡沫：流向圖的泡沫、急流、岸邊淺水；用沿流向移動的雜訊打碎成條紋 ----
    vec2 foamP = p * 1.6 - flow * speed * uTime * 1.2;
    float foamNoise = noise(foamP) * 0.6 + noise(foamP * 2.7 + 5.1) * 0.4;
    float foamAmount = clamp(foamMap * 0.45 + smoothstep(1.6, 2.4, speed) * 0.25 + (1.0 - smoothstep(0.03, 0.1, depth)) * 0.15, 0.0, 0.6);
    float streaks = noise(vec2(dot(p, normalize(flow + 1e-4)) * 0.6, dot(p, vec2(-flow.y, flow.x)) * 3.5) - vec2(speed * uTime * 0.8, 0.0));
    foamAmount *= smoothstep(0.66, 0.95, foamNoise * 0.6 + streaks * 0.4 + foamAmount * 0.15);
    // 遠處泡沫細節會閃爍，淡掉
    foamAmount *= 1.0 - far * 0.6;
    color = mix(color, vec3(0.8, 0.83, 0.82) * (uHorizon * 0.5 + uSunColor * 0.55) * light, foamAmount * 0.5);

    float alpha = mix(0.55, 0.95, absorb) + fresnel * 0.4 + foamAmount * 0.4;
    // 岸邊淡出，避免水面與地形交界的硬邊
    alpha *= smoothstep(0.0, 0.1, depth);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** 平面反射的解析度（相對於畫面），0 表示關閉 */
export type ReflectionScale = number;

/**
 * 平面反射：鏡射平面放在鏡頭附近的水面高度（由水面網格的頂點建成 8 m 格的高度表）。
 * 在主場景開始畫之前（scene.onBeforeRender）先畫鏡射畫面；水面、草地不畫進倒影，也不重算陰影。
 */
class PlanarReflection {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  readonly matrix = new THREE.Matrix4();
  readonly camera = new THREE.PerspectiveCamera();
  planeY = 0;
  active = false;
  scale: ReflectionScale = 0.5;
  /** 不畫進倒影的物件（例如草地） */
  readonly hidden: THREE.Object3D[] = [];
  private readonly heights = new Map<string, { sum: number; count: number }>();
  private readonly sampled = new WeakSet<THREE.Mesh>();
  private rendering = false;
  private readonly plane = new THREE.Plane();
  private readonly size = new THREE.Vector2();
  private static readonly CELL = 8;

  /** 記錄水面網格的頂點高度（第一次畫的時候 matrixWorld 才確定） */
  sample(mesh: THREE.Mesh): void {
    if (this.sampled.has(mesh)) {
      return;
    }
    this.sampled.add(mesh);
    const position = mesh.geometry.getAttribute('position');
    if (!position) {
      return;
    }
    const v = new THREE.Vector3();
    const step = Math.max(1, Math.floor(position.count / 4000));
    for (let i = 0; i < position.count; i += step) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      const key = `${Math.floor(v.x / PlanarReflection.CELL)},${Math.floor(v.z / PlanarReflection.CELL)}`;
      const cell = this.heights.get(key) ?? { sum: 0, count: 0 };
      cell.sum += v.y;
      cell.count++;
      this.heights.set(key, cell);
    }
  }

  /** 鏡頭附近（水平 60 m 內）最近一格水面的高度；附近沒有水時回傳 null */
  private nearbyWater(position: THREE.Vector3): number | null {
    const cx = Math.floor(position.x / PlanarReflection.CELL);
    const cz = Math.floor(position.z / PlanarReflection.CELL);
    const reach = Math.ceil(60 / PlanarReflection.CELL);
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let dz = -reach; dz <= reach; dz++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const d = dx * dx + dz * dz;
        if (d >= bestDistance) {
          continue;
        }
        const cell = this.heights.get(`${cx + dx},${cz + dz}`);
        if (cell) {
          best = cell.sum / cell.count;
          bestDistance = d;
        }
      }
    }
    return best;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, waterMaterials: THREE.Material[]): void {
    if (this.rendering || !(camera instanceof THREE.PerspectiveCamera)) {
      return;
    }
    const planeY = this.scale > 0 ? this.nearbyWater(camera.position) : null;
    // 鏡頭在水面下或附近沒有水：不畫倒影
    if (planeY === null || camera.position.y < planeY + 0.05) {
      this.active = false;
      return;
    }
    this.planeY = planeY;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(64, Math.round(this.size.x * this.scale));
    const h = Math.max(64, Math.round(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }

    // 鏡射相機：位置、朝向、上方向都對 y = planeY 鏡射
    const mirror = this.camera;
    mirror.copy(camera);
    mirror.far = Math.min(camera.far, 600);
    const pos = camera.position;
    mirror.position.set(pos.x, 2 * planeY - pos.y, pos.z);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = -forward.y;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    up.y = -up.y;
    mirror.up.copy(up);
    mirror.lookAt(mirror.position.clone().add(forward));
    mirror.updateProjectionMatrix();
    mirror.updateMatrixWorld();

    // 斜近裁切面：把水面以下的東西切掉（Lengyel 的 oblique frustum）
    this.plane.set(new THREE.Vector3(0, 1, 0), -planeY);
    this.plane.applyMatrix4(mirror.matrixWorldInverse);
    const clip = new THREE.Vector4(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant - 0.05);
    const proj = mirror.projectionMatrix;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + proj.elements[8]!) / proj.elements[0]!,
      (Math.sign(clip.y) + proj.elements[9]!) / proj.elements[5]!,
      -1,
      (1 + proj.elements[10]!) / proj.elements[14]!,
    );
    clip.multiplyScalar(2 / clip.dot(q));
    proj.elements[2] = clip.x;
    proj.elements[6] = clip.y;
    proj.elements[10] = clip.z + 1;
    proj.elements[14] = clip.w;
    mirror.projectionMatrixInverse.copy(proj).invert();

    // 世界座標 → 反射貼圖座標
    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(proj).multiply(mirror.matrixWorldInverse);

    const previousTarget = renderer.getRenderTarget();
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const hiddenState = this.hidden.map((o) => o.visible);
    renderer.shadowMap.autoUpdate = false;
    for (const m of waterMaterials) m.visible = false;
    for (const o of this.hidden) o.visible = false;
    this.rendering = true;
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, mirror);
    } finally {
      this.rendering = false;
      renderer.setRenderTarget(previousTarget);
      renderer.shadowMap.autoUpdate = shadowAuto;
      for (const m of waterMaterials) m.visible = true;
      this.hidden.forEach((o, i) => (o.visible = hiddenState[i]!));
    }
    this.active = true;
  }

  dispose(): void {
    this.target.dispose();
  }
}

export class WaterMaterials {
  private readonly uniforms: Record<string, THREE.IUniform>;
  readonly water: THREE.ShaderMaterial;
  readonly waterfall: THREE.ShaderMaterial;
  private readonly textures: THREE.Texture[] = [];
  private readonly reflection = new PlanarReflection();
  private readonly previousSceneHook: THREE.Scene['onBeforeRender'];

  constructor(
    lighting: WaterLighting,
    surface: WaterSurface | undefined,
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
      uShallow: { value: new THREE.Color(0.1, 0.12, 0.075) },
      uDeep: { value: new THREE.Color(0.01, 0.03, 0.032) },
      uReflection: { value: this.reflection.target.texture },
      uReflectionOn: { value: 0 },
      uReflectionPlane: { value: 0 },
      uReflectionMatrix: { value: this.reflection.matrix },
      uUnder: { value: 0 },
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

    // 主場景開始畫之前先畫倒影
    this.previousSceneHook = scene.onBeforeRender;
    // Scene 的 onBeforeRender 實際收到 (renderer, scene, camera, renderTarget)，與 Object3D 的型別宣告不同
    const hook = (...args: [THREE.WebGLRenderer, THREE.Scene, THREE.Camera, THREE.WebGLRenderTarget | null]) => {
      (this.previousSceneHook as unknown as (...a: typeof args) => void).apply(scene, args);
      const [renderer, , camera, renderTarget] = args;
      if (renderTarget !== null) {
        return;
      }
      this.reflection.render(renderer, scene, camera, [this.water, this.waterfall]);
      this.uniforms.uReflectionOn!.value = this.reflection.active ? 1 : 0;
      this.uniforms.uReflectionPlane!.value = this.reflection.planeY;
    };
    scene.onBeforeRender = hook as unknown as THREE.Scene['onBeforeRender'];
  }

  /** 倒影解析度（相對於畫面）；0 關閉，改用天空顏色 */
  setReflectionScale(scale: ReflectionScale): void {
    this.reflection.scale = scale;
  }

  /** 不畫進倒影的物件（草地太細，畫進倒影只會閃爍又耗效能） */
  excludeFromReflection(object: THREE.Object3D): void {
    this.reflection.hidden.push(object);
  }

  update(seconds: number): void {
    this.uniforms.uTime!.value = seconds;
  }

  /** 鏡頭在水下時畫水面的背面（從下往上看的水面）。 */
  setUnderwater(under: boolean): void {
    const side = under ? THREE.DoubleSide : THREE.FrontSide;
    if (this.water.side !== side) {
      this.water.side = side;
      this.water.needsUpdate = true;
    }
    this.uniforms.uUnder!.value = under ? 1 : 0;
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
    if (kind === 'water') {
      mesh.onBeforeRender = () => this.reflection.sample(mesh);
    }
    return true;
  }

  dispose(): void {
    this.scene.onBeforeRender = this.previousSceneHook;
    this.reflection.dispose();
    this.water.dispose();
    this.waterfall.dispose();
    for (const t of this.textures) {
      t.dispose();
    }
  }
}
