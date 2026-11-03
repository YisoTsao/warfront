import { horizontalDistanceToBounds, type MapChunk, type MapManifest } from '@frontline/map-schema';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** 細節分塊卸載時的額外距離，避免在邊界來回載入／卸載。 */
const UNLOAD_HYSTERESIS = 1.3;
const MAX_CONCURRENT_LOADS = 3;
const DEFAULT_LOD_DISTANCES = [70, 160];

interface ChunkEntry {
  chunk: MapChunk;
  state: 'idle' | 'loading' | 'loaded' | 'failed';
  group: THREE.Group | null;
  lodGroups: LodGroup[];
  loadedAt: number;
  loadMs: number;
}

interface LodGroup {
  center: THREE.Vector3;
  levels: THREE.Object3D[];
  distances: number[];
}

export interface StreamingStats {
  loaded: number;
  loadedIds: string[];
  loading: number;
  total: number;
  failed: number;
  bytesLoaded: number;
  averageLoadMs: number;
}

/**
 * 依玩家位置串流地圖分塊。地形分塊（priority 0、沒有 streamDistance）一開始就全部載入；
 * 細節分塊在 streamDistance 內載入、超出後卸載並釋放 GPU 資源。
 */
export class ChunkStreamer {
  private readonly loader: GLTFLoader;
  private readonly ktx2: KTX2Loader;
  private readonly entries: ChunkEntry[];
  private readonly root = new THREE.Group();
  private active = 0;
  private bytesLoaded = 0;
  private disposed = false;
  private readonly lodLevel: number[] = [];
  /** 依畫質等級調整串流距離的倍率 */
  distanceScale = 1;

  constructor(
    private readonly manifest: MapManifest,
    private readonly baseUrl: string,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private readonly shadows: { cast: boolean },
  ) {
    this.ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(this.ktx2);
    this.entries = manifest.chunks.map((chunk) => ({ chunk, state: 'idle', group: null, lodGroups: [], loadedAt: 0, loadMs: 0 }));
    this.root.name = `map:${manifest.id}`;
    scene.add(this.root);
  }

  /** 載入必要分塊（地形與 focus 附近），完成後才允許玩家出生。 */
  async preload(focus: THREE.Vector3, onProgress?: (done: number, total: number) => void): Promise<void> {
    const required = this.entries.filter((e) => this.shouldLoad(e, focus));
    let done = 0;
    await Promise.all(
      required.map((entry) =>
        this.load(entry).then(() => {
          done++;
          onProgress?.(done, required.length);
        }),
      ),
    );
  }

  /** 每 0.25 秒左右呼叫一次：載入進入範圍的分塊、卸載離開範圍的分塊、切換 LOD。 */
  update(focus: THREE.Vector3): void {
    if (this.disposed) {
      return;
    }
    const candidates = this.entries
      .filter((e) => e.state === 'idle' && this.shouldLoad(e, focus))
      .sort((a, b) => a.chunk.priority - b.chunk.priority || this.distance(a, focus) - this.distance(b, focus));
    for (const entry of candidates) {
      if (this.active >= MAX_CONCURRENT_LOADS) {
        break;
      }
      void this.load(entry);
    }
    for (const entry of this.entries) {
      const limit = entry.chunk.streamDistance;
      if (entry.state === 'loaded' && limit !== undefined && this.distance(entry, focus) > limit * this.distanceScale * UNLOAD_HYSTERESIS) {
        this.unload(entry);
      }
    }
    this.updateLods(focus);
  }

  stats(): StreamingStats {
    const loaded = this.entries.filter((e) => e.state === 'loaded');
    return {
      loaded: loaded.length,
      loadedIds: loaded.map((e) => e.chunk.id).sort(),
      loading: this.entries.filter((e) => e.state === 'loading').length,
      failed: this.entries.filter((e) => e.state === 'failed').length,
      total: this.entries.length,
      bytesLoaded: this.bytesLoaded,
      averageLoadMs: loaded.length ? loaded.reduce((s, e) => s + e.loadMs, 0) / loaded.length : 0,
    };
  }

  setShadows(cast: boolean): void {
    this.shadows.cast = cast;
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = cast && o.userData.castShadow !== false;
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries) {
      this.unload(entry);
    }
    this.root.removeFromParent();
    this.ktx2.dispose();
  }

  private distance(entry: ChunkEntry, focus: THREE.Vector3): number {
    return horizontalDistanceToBounds(focus.x, focus.z, entry.chunk.bounds);
  }

  private shouldLoad(entry: ChunkEntry, focus: THREE.Vector3): boolean {
    const limit = entry.chunk.streamDistance;
    return limit === undefined || this.distance(entry, focus) <= limit * this.distanceScale;
  }

  private async load(entry: ChunkEntry): Promise<void> {
    if (entry.state !== 'idle') {
      return;
    }
    entry.state = 'loading';
    this.active++;
    const started = performance.now();
    try {
      const gltf = await this.loader.loadAsync(`${this.baseUrl}${entry.chunk.path}`);
      if (this.disposed) {
        disposeObject(gltf.scene);
        return;
      }
      const group = gltf.scene;
      group.name = `chunk:${entry.chunk.id}`;
      const terrain = entry.chunk.id.startsWith('terrain');
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const transparent = Array.isArray(o.material) ? o.material.some((m) => m.transparent) : o.material.transparent;
          o.userData.castShadow = !terrain && !transparent;
          o.castShadow = this.shadows.cast && o.userData.castShadow === true;
          o.receiveShadow = !transparent;
          if (o instanceof THREE.InstancedMesh) {
            o.computeBoundingSphere();
          }
        }
      });
      entry.lodGroups = collectLodGroups(group);
      entry.group = group;
      entry.state = 'loaded';
      entry.loadMs = performance.now() - started;
      entry.loadedAt = performance.now();
      this.bytesLoaded += entry.chunk.byteLength ?? 0;
      this.root.add(group);
    } catch (error) {
      entry.state = 'failed';
      console.error(`地圖分塊載入失敗：${entry.chunk.path}`, error);
    } finally {
      this.active--;
    }
  }

  private unload(entry: ChunkEntry): void {
    if (entry.group) {
      this.root.remove(entry.group);
      disposeObject(entry.group);
    }
    entry.group = null;
    entry.lodGroups = [];
    if (entry.state === 'loaded') {
      entry.state = 'idle';
    }
  }

  private updateLods(focus: THREE.Vector3): void {
    for (const entry of this.entries) {
      for (const lod of entry.lodGroups) {
        const d = Math.hypot(lod.center.x - focus.x, lod.center.z - focus.z);
        let level = lod.distances.findIndex((limit) => d < limit * this.distanceScale);
        if (level === -1) {
          level = lod.levels.length - 1;
        }
        lod.levels.forEach((obj, i) => {
          obj.visible = i === level;
        });
      }
    }
    this.lodLevel.length = 0;
  }
}

/** 依 map-build 寫入的 extras（lod_group、lod_level、lod_distances）建立 LOD 群組。 */
function collectLodGroups(root: THREE.Object3D): LodGroup[] {
  const groups = new Map<string, LodGroup>();
  root.traverse((o) => {
    const data = o.userData as { lod_group?: string; lod_level?: number; lod_distances?: number[] };
    if (typeof data.lod_group !== 'string' || typeof data.lod_level !== 'number') {
      return;
    }
    let group = groups.get(data.lod_group);
    if (!group) {
      group = { center: new THREE.Vector3(), levels: [], distances: data.lod_distances ?? DEFAULT_LOD_DISTANCES };
      groups.set(data.lod_group, group);
    }
    group.levels[data.lod_level] = o;
  });
  for (const group of groups.values()) {
    const box = new THREE.Box3();
    for (const level of group.levels) {
      if (level) {
        box.expandByObject(level);
      }
    }
    box.getCenter(group.center);
    group.levels = group.levels.filter(Boolean);
  }
  return [...groups.values()].filter((g) => g.levels.length > 1);
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) {
            value.dispose();
          }
        }
        material.dispose();
      }
      if (o instanceof THREE.InstancedMesh) {
        o.dispose();
      }
    }
  });
}
