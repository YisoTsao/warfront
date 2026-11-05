import * as THREE from 'three';

/**
 * 天空的雲層：一個跟著鏡頭的半球，片段 shader 把視線投影到 1500 m 高的雲平面，
 * 用多層 FBM 雜訊算覆蓋率與厚度，隨風緩慢飄移。
 * - 受光：朝太陽的一側亮、厚的地方暗，太陽附近有一點穿透的光暈；
 * - 地平線附近淡出並混入霧色，與物理天空背景自然銜接；
 * - 不寫深度、在所有不透明物體之前畫（renderOrder −10），不參與霧與色調以外的任何計算。
 * 天空背景是預先畫好的立方體貼圖，雲層另外疊在上面，所以可以動。
 */
const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w * 0.9999;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform float uCoverage;
  varying vec3 vDir;

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
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = r * p * 2.03 + 11.7;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    if (dir.y < 0.01) discard;
    // 視線與 1500 m 高雲平面的交點（以公里為單位）
    vec2 p = dir.xz / dir.y * 1.5;
    vec2 wind = vec2(0.012, 0.007) * uTime;
    float shape = fbm(p * 0.55 + wind);
    float detail = fbm(p * 2.1 + wind * 1.8);
    float density = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.28, shape * 0.78 + detail * 0.32);
    // 往太陽方向取樣第二次：被自己遮住的地方比較暗
    vec2 toSun = normalize(uSunDir.xz + 1e-4) * 0.18;
    float shadowed = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.4, fbm((p + toSun) * 0.55 + wind) * 0.78 + detail * 0.32);
    float sunAmount = max(dot(dir, uSunDir), 0.0);
    vec3 lit = uSunColor * (1.05 - shadowed * 0.5);
    vec3 shade = mix(uHorizon, uZenith, 0.35) * 0.9;
    vec3 color = mix(shade, lit, 0.55 + 0.45 * (1.0 - density * 0.6));
    color += uSunColor * pow(sunAmount, 12.0) * 0.6 * (1.0 - density * 0.5);
    // 地平線淡出並混入霧色（遠處的雲被大氣稀釋）
    float horizonFade = smoothstep(0.02, 0.22, dir.y);
    color = mix(uHorizon, color, smoothstep(0.02, 0.4, dir.y));
    gl_FragColor = vec4(color, density * horizonFade * 0.92);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface CloudLighting {
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
  zenith: THREE.Color;
}

export class CloudLayer {
  private readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor(
    private readonly scene: THREE.Scene,
    lighting: CloudLighting,
    coverage = 0.42,
  ) {
    const geometry = new THREE.SphereGeometry(1000, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      name: 'frontline-clouds',
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: lighting.sunDirection.clone().normalize() },
        // 雲的亮度以天空校正後的地平線為基準，避免比天空亮太多而過曝
        uSunColor: { value: lighting.sunColor.clone().multiplyScalar(Math.max(0.35, lighting.horizon.r + lighting.horizon.g + lighting.horizon.b) * 0.55) },
        uHorizon: { value: lighting.horizon.clone() },
        uZenith: { value: lighting.zenith.clone() },
        uCoverage: { value: coverage },
      },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'clouds';
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      this.mesh.position.setFromMatrixPosition(camera.matrixWorld);
      this.mesh.updateMatrixWorld();
    };
    scene.add(this.mesh);
  }

  update(seconds: number): void {
    this.mesh.material.uniforms.uTime!.value = seconds;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
