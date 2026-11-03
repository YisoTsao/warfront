import { GRAYBOX_LAYOUT, GRAYBOX_MAP_ID, type MapManifest, type SpawnPoint } from '@frontline/map-schema';
import { SimWorld, loadMapData } from '@frontline/simulation';
import * as THREE from 'three';
import { ChunkStreamer, type StreamingStats } from './ChunkStreamer';
import { applyEnvironment, followShadow, type EnvironmentHandles } from './Environment';
import { buildGrayboxVisuals } from './GrayboxMap';

export const AVAILABLE_MAPS = [
  { id: GRAYBOX_MAP_ID, name: '灰盒測試場' },
  { id: 'sample-valley', name: '範例谷地（GLB 匯入）' },
] as const;

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
  ) {}

  static async load(
    mapId: string,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    stepSeconds: number,
    shadows: { cast: boolean },
    focus: THREE.Vector3 | null,
    onProgress?: (p: MapLoadProgress) => void,
    streamScale = 1,
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
    const environment = applyEnvironment(scene, data.manifest.environment);
    environment.sun.castShadow = shadows.cast;
    let streamer: ChunkStreamer | null = null;
    let graybox: THREE.Group | null = null;
    if (mapId === GRAYBOX_MAP_ID) {
      graybox = buildGrayboxVisuals(GRAYBOX_LAYOUT, scene);
    } else {
      streamer = new ChunkStreamer(data.manifest, data.baseUrl, scene, renderer, shadows);
      streamer.distanceScale = streamScale;
      const start = focus ?? new THREE.Vector3(...(data.manifest.spawns[0]?.position ?? [0, 0, 0]));
      await streamer.preload(start, (done, total) => onProgress?.({ stage: 'chunks', done, total }));
    }
    onProgress?.({ stage: 'ready', done: 1, total: 1 });
    return new MapRuntime(data.manifest, sim, scene, environment, streamer, graybox);
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
    followShadow(this.environment.sun, this.shadowFocus, this.manifest.environment.sunDirection);
    this.streamTimer -= frameSeconds;
    if (this.streamTimer <= 0) {
      this.streamTimer = 0.25;
      this.streamer?.update(focus);
    }
  }

  setQuality(options: { shadows: boolean; shadowMapSize: number; streamScale: number }): void {
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

  streamingStats(): StreamingStats | null {
    return this.streamer?.stats() ?? null;
  }

  dispose(): void {
    this.streamer?.dispose();
    if (this.graybox) {
      this.scene.remove(this.graybox);
    }
    this.environment.dispose();
    this.sim.dispose();
  }
}
