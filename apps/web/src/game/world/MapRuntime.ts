import { GRAYBOX_LAYOUT, GRAYBOX_MAP_ID, type MapManifest, type SpawnPoint } from '@frontline/map-schema';
import { SimWorld, loadMapData } from '@frontline/simulation';
import * as THREE from 'three';
import { ChunkStreamer, type StreamingStats } from './ChunkStreamer';
import { CloudLayer } from './CloudLayer';
import { applyEnvironment, followShadow, type EnvironmentHandles } from './Environment';
import { GRASS_QUALITY, GrassField, type GrassQuality } from './GrassField';
import { buildGrayboxVisuals } from './GrayboxMap';
import { TerrainMaterials } from './TerrainMaterial';
import { WaterMaterials } from './WaterMaterial';

export { AVAILABLE_MAPS } from './maps';

export interface MapLoadProgress {
  stage: 'manifest' | 'chunks' | 'ready';
  done: number;
  total: number;
}

/**
 * 一張地圖在用戶端的執行期資料：視覺（灰盒方塊或 GLB 分塊）、環境光、
 * 與伺服器相同的碰撞世界（SimWorld）。
 */
export class MapRuntime {
  private shadowFocus = new THREE.Vector3();
  private streamTimer = 0;

  private constructor(
    readonly manifest: MapManifest,
    readonly sim: SimWorld,
    private readonly scene: THREE.Scene,
    private readonly environment: EnvironmentHandles,
    private readonly streamer: ChunkStreamer | null,
    private readonly graybox: THREE.Group | null,
    private readonly water: WaterMaterials,
    private readonly clouds: CloudLayer | null,
    private readonly grass: GrassField | null,
    private readonly terrain: TerrainMaterials,
  ) {}
  private time = 0;
  private savedFog: THREE.Scene['fog'] = null;
  private savedBackground: THREE.Scene['background'] = null;
  private readonly underwaterFog = new THREE.Fog(0x0b3532, 0.2, 14);
  private underwater = false;

  static async load(
    mapId: string,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    stepSeconds: number,
    shadows: { cast: boolean },
    focus: THREE.Vector3 | null,
    onProgress?: (p: MapLoadProgress) => void,
    streamScale = 1,
    grassQuality: GrassQuality = GRASS_QUALITY.high,
    reflectionScale = 0.5,
  ): Promise<MapRuntime> {
    onProgress?.({ stage: 'manifest', done: 0, total: 1 });
    const data = await loadMapData(mapId, '/maps', async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`無法下載地圖資料 ${url}（HTTP ${response.status}）`);
      }
      return response.json() as Promise<unknown>;
    });
    const sim = new SimWorld(data.manifest, data.collision, stepSeconds);
    const environment = applyEnvironment(scene, data.manifest.environment, renderer);
    const [sx, sy, sz] = data.manifest.environment.sunDirection;
    const water = new WaterMaterials(
      {
        sunDirection: new THREE.Vector3(-sx, -sy, -sz),
        sunColor: new THREE.Color(data.manifest.environment.sunColor),
        horizon: environment.horizonColor,
        zenith: environment.zenithColor,
      },
      data.manifest.water,
      data.baseUrl,
      scene,
    );
    environment.sun.castShadow = shadows.cast;
    const lighting = {
      sunDirection: new THREE.Vector3(-sx, -sy, -sz),
      sunColor: new THREE.Color(data.manifest.environment.sunColor),
      horizon: environment.horizonColor,
      zenith: environment.zenithColor,
    };
    // 灰盒是測試用的素色場景，不加雲與草
    const clouds = mapId === GRAYBOX_MAP_ID ? null : new CloudLayer(scene, lighting);
    const heightfield = data.collision.colliders.find((c) => c.kind === 'heightfield');
    const grass = data.manifest.grass && heightfield ? new GrassField(data.manifest.grass, heightfield, data.baseUrl, scene) : null;
    grass?.setQuality(grassQuality);
    if (grass) {
      water.excludeFromReflection(grass.group);
    }
    water.setReflectionScale(reflectionScale);
    const terrain = await TerrainMaterials.load(data.manifest.terrain, data.manifest.water, data.baseUrl, renderer);
    let streamer: ChunkStreamer | null = null;
    let graybox: THREE.Group | null = null;
    if (mapId === GRAYBOX_MAP_ID) {
      graybox = buildGrayboxVisuals(GRAYBOX_LAYOUT, scene);
    } else {
      streamer = new ChunkStreamer(data.manifest, data.baseUrl, scene, renderer, shadows);
      streamer.distanceScale = streamScale;
      streamer.replaceMaterial = (mesh) => terrain.apply(mesh) || water.apply(mesh);
      const start = focus ?? new THREE.Vector3(...(data.manifest.spawns[0]?.position ?? [0, 0, 0]));
      await streamer.preload(start, (done, total) => onProgress?.({ stage: 'chunks', done, total }));
    }
    onProgress?.({ stage: 'ready', done: 1, total: 1 });
    return new MapRuntime(data.manifest, sim, scene, environment, streamer, graybox, water, clouds, grass, terrain);
  }

  get id(): string {
    return this.manifest.id;
  }

  /** 單機時使用的出生點：優先用沒有隊伍限制的，否則用第一個。 */
  defaultSpawn(): SpawnPoint {
    return this.manifest.spawns.find((s) => s.team === undefined) ?? this.manifest.spawns[0]!;
  }

  /** 每畫格呼叫：陰影跟隨；每 0.25 秒更新一次分塊串流與 LOD。 */
  update(focus: THREE.Vector3, frameSeconds: number): void {
    this.shadowFocus.copy(focus);
    this.time += frameSeconds;
    this.water.update(this.time);
    this.terrain.update(this.time);
    this.clouds?.update(this.time);
    this.grass?.update(focus, this.time);
    followShadow(this.environment.sun, this.shadowFocus, this.manifest.environment.sunDirection);
    this.streamTimer -= frameSeconds;
    if (this.streamTimer <= 0) {
      this.streamTimer = 0.25;
      this.streamer?.update(focus);
    }
  }

  /**
   * 鏡頭所在的水深（公尺；不在水下為 0）。水下時把霧與背景換成水色（深水看得更近），
   * 並畫水面背面；回到水面上時還原。
   */
  updateCamera(camera: THREE.Vector3): number {
    let depth = 0;
    let deep = false;
    for (const v of this.manifest.waterVolumes) {
      const b = v.bounds;
      if (camera.x < b.min[0] || camera.x > b.max[0] || camera.z < b.min[2] || camera.z > b.max[2] || camera.y < b.min[1]) continue;
      // 水體上緣比水面高 0.05 m（見森林谷地匯入器）
      const d = b.max[1] - 0.05 - camera.y;
      if (d > depth) {
        depth = d;
        deep = v.depth === 'deep';
      }
    }
    const under = depth > 0;
    if (under !== this.underwater) {
      this.underwater = under;
      if (under) {
        this.savedFog = this.scene.fog;
        this.savedBackground = this.scene.background;
        this.scene.fog = this.underwaterFog;
        this.scene.background = this.underwaterFog.color;
      } else {
        this.scene.fog = this.savedFog;
        this.scene.background = this.savedBackground;
      }
      this.water.setUnderwater(under);
    }
    if (under) {
      this.underwaterFog.far = (deep ? 11 : 16) - Math.min(depth, 4) * 1.2;
      this.underwaterFog.color.setRGB(0.04, 0.2, 0.19).multiplyScalar(1 - Math.min(depth, 5) * 0.1);
    }
    return depth;
  }

  setQuality(options: { shadows: boolean; shadowMapSize: number; streamScale: number; grass: GrassQuality; reflectionScale: number }): void {
    this.grass?.setQuality(options.grass);
    // 地形細節貼圖淡回底色的距離跟著植被畫質（低 120 m、中 200 m、高 260 m）
    this.terrain.setDetailDistance(options.grass.near <= GRASS_QUALITY.low.near ? 120 : options.grass.near <= GRASS_QUALITY.medium.near ? 200 : 260);
    this.water.setReflectionScale(options.reflectionScale);
    this.environment.sun.castShadow = options.shadows;
    if (this.environment.sun.shadow.mapSize.x !== options.shadowMapSize) {
      this.environment.sun.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize);
      this.environment.sun.shadow.map?.dispose();
      this.environment.sun.shadow.map = null;
    }
    if (this.streamer) {
      this.streamer.distanceScale = options.streamScale;
      this.streamer.setShadows(options.shadows);
    }
  }

  /** 草叢實例數（除錯與測試用；沒有草地時為 0） */
  grassInstances(): number {
    return this.grass?.instanceCount() ?? 0;
  }

  streamingStats(): StreamingStats | null {
    return this.streamer?.stats() ?? null;
  }

  dispose(): void {
    this.streamer?.dispose();
    if (this.graybox) {
      this.scene.remove(this.graybox);
    }
    this.environment.dispose();
    this.water.dispose();
    this.terrain.dispose();
    this.clouds?.dispose();
    this.grass?.dispose();
    this.sim.dispose();
  }
}
