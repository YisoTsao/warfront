import { horizontalDistanceToBounds, type MapChunk, type MapManifest } from '@frontline/map-schema';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** 細節分塊卸載時的額外距離，避免在邊界來回載入／卸載。 */
const UNLOAD_HYSTERESIS = 1.3;
const MAX_CONCURRENT_LOADS = 3;
const DEFAULT_LOD_DISTANCES = [70, 160];
/** 玩家移動超過這個距離（公尺）才重新分配逐實例 LOD */
const INSTANCE_LOD_STEP = 1.5;

interface ChunkEntry {
  chunk: MapChunk;
  state: 'idle' | 'loading' | 'loaded' | 'failed';
  group: THREE.Group | null;
  lodGroups: ObjectLod[];
  instancedLods: InstancedLod[];
  loadedAt: number;
  loadMs: number;
}

/** 一般物件的 LOD：整個物件依與包圍盒的距離切換。 */
interface ObjectLod {
  box: THREE.Box3;
  levels: THREE.Object3D[];
  distances: number[];
}

/**
 * GPU instancing 的逐實例 LOD：每個實例依自己的距離放進對應層級的 InstancedMesh。
 * 每個層級可能有多個 InstancedMesh（同一網格的多個材質），共用同一份實例矩陣。
 */
interface InstancedLod {
  all: Float32Array;
  levels: Array<{ meshes: THREE.InstancedMesh[]; attr: THREE.InstancedBufferAttribute }>;
  distances: number[];
  cull: number | undefined;
}

interface LibraryPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

interface LibraryEntry {
  parts: LibraryPart[];
  /** 網格庫節點的變換（Meshopt 量化的還原縮放與位移），要乘在每個實例矩陣右邊 */
  matrix: THREE.Matrix4 | null;
}

export interface StreamingStats {
  loaded: number;
  loadedIds: string[];
  loading: number;
  total: number;
  failed: number;
  bytesLoaded: number;
  averageLoadMs: number;
  /** 共用網格庫中的網格數（沒有網格庫時為 0） */
  libraryMeshes: number;
  /** 共用貼圖數 */
  sharedTextures: number;
  /** 目前畫出的實例數（逐實例 LOD 之後） */
  visibleInstances: number;
}

type TextureSlot = 'map' | 'normalMap' | 'roughnessMap' | 'aoMap' | 'emissiveMap';

/**
 * 依玩家位置串流地圖分塊。地形分塊（priority 0、沒有 streamDistance）一開始就全部載入；
 * 細節分塊在 streamDistance 內載入、超出後卸載並釋放 GPU 資源。
 *
 * map-build 的兩種共用資源：
 * - 共用網格庫（manifest.library）：分塊內 extras.library_mesh 的佔位網格換成網格庫的幾何與材質；
 * - 共用貼圖（材質 extras.frontline_textures）：同一張貼圖只下載與上傳一次。
 * 共用的幾何、材質與貼圖標記 userData.shared，卸載分塊時不釋放。
 */
export class ChunkStreamer {
  private readonly loader: GLTFLoader;
  private readonly ktx2: KTX2Loader;
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly entries: ChunkEntry[];
  private readonly root = new THREE.Group();
  private readonly textures = new Map<string, Promise<THREE.Texture>>();
  private library: Map<string, LibraryEntry> | null = null;
  private libraryScene: THREE.Object3D | null = null;
  private active = 0;
  private bytesLoaded = 0;
  private disposed = false;
  private readonly lastLodFocus = new THREE.Vector3(Infinity, 0, Infinity);
  private lastLodScale = 0;
  private visibleInstances = 0;
  /** 依畫質等級調整串流距離的倍率 */
  distanceScale = 1;
  /** 換掉特殊材質（例如水面）；回傳 true 表示已替換 */
  replaceMaterial: ((mesh: THREE.Mesh) => boolean) | null = null;

  constructor(
    private readonly manifest: MapManifest,
    private readonly baseUrl: string,
    scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly shadows: { cast: boolean },
  ) {
    this.ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(this.ktx2);
    this.entries = manifest.chunks.map((chunk) => ({ chunk, state: 'idle', group: null, lodGroups: [], instancedLods: [], loadedAt: 0, loadMs: 0 }));
    this.root.name = `map:${manifest.id}`;
    scene.add(this.root);
  }

  /** 載入共用網格庫、必要分塊（地形與 focus 附近），完成後才允許玩家出生。 */
  async preload(focus: THREE.Vector3, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.manifest.library) {
      await this.loadLibrary(this.manifest.library.path);
      this.bytesLoaded += this.manifest.library.byteLength ?? 0;
    }
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
    this.updateLods(focus, true);
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
    this.updateLods(focus, false);
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
      libraryMeshes: this.library?.size ?? 0,
      sharedTextures: this.textures.size,
      visibleInstances: this.visibleInstances,
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
    if (this.libraryScene) {
      disposeObject(this.libraryScene, true);
    }
    for (const texture of this.textures.values()) {
      void texture.then((t) => t.dispose()).catch(() => undefined);
    }
    this.ktx2.dispose();
  }

  private distance(entry: ChunkEntry, focus: THREE.Vector3): number {
    return horizontalDistanceToBounds(focus.x, focus.z, entry.chunk.bounds);
  }

  private shouldLoad(entry: ChunkEntry, focus: THREE.Vector3): boolean {
    const limit = entry.chunk.streamDistance;
    return limit === undefined || this.distance(entry, focus) <= limit * this.distanceScale;
  }

  private texture(path: string, slot: TextureSlot): Promise<THREE.Texture> {
    const color = slot === 'map' || slot === 'emissiveMap';
    const key = `${path}|${color ? 'srgb' : 'linear'}`;
    let pending = this.textures.get(key);
    if (!pending) {
      pending = this.textureLoader.loadAsync(`${this.baseUrl}${path}`).then((t) => {
        t.flipY = false;
        t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        t.userData.shared = true;
        t.needsUpdate = true;
        return t;
      });
      this.textures.set(key, pending);
    }
    return pending;
  }

  /** 材質 extras.frontline_textures 指定的共用貼圖。 */
  private async applySharedTextures(root: THREE.Object3D): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) {
        return;
      }
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
        const refs = material.userData.frontline_textures as Partial<Record<TextureSlot, string>> | undefined;
        if (!refs || material.userData.texturesApplied) {
          continue;
        }
        material.userData.texturesApplied = true;
        for (const [slot, path] of Object.entries(refs) as Array<[TextureSlot, string]>) {
          jobs.push(
            this.texture(path, slot).then((t) => {
              const m = material as THREE.MeshStandardMaterial;
              if (slot === 'roughnessMap') {
                m.roughnessMap = t;
                m.metalnessMap = t;
              } else {
                m[slot] = t;
              }
              m.needsUpdate = true;
            }),
          );
        }
      }
    });
    await Promise.all(jobs);
  }

  private async loadLibrary(path: string): Promise<void> {
    const gltf = await this.loader.loadAsync(`${this.baseUrl}${path}`);
    await this.applySharedTextures(gltf.scene);
    const library = new Map<string, LibraryEntry>();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const name = o.userData.library_mesh;
      if (typeof name !== 'string' || library.has(name)) {
        return;
      }
      const parts: LibraryPart[] = [];
      let matrix: THREE.Matrix4 | null = null;
      o.traverse((m) => {
        if (m instanceof THREE.Mesh) {
          m.geometry.userData.shared = true;
          for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
            material.userData.shared = true;
          }
          parts.push({ geometry: m.geometry, material: m.material });
          matrix ??= m.matrixWorld.clone();
        }
      });
      const identity = matrix === null || (matrix as THREE.Matrix4).equals(new THREE.Matrix4());
      library.set(name, { parts, matrix: identity ? null : matrix });
    });
    for (const entry of library.values()) {
      prepareFoliage(entry.parts);
    }
    this.library = library;
    this.libraryScene = gltf.scene;
  }

  /** 把分塊裡的佔位實例換成網格庫的幾何與材質，共用同一份實例矩陣。 */
  private resolveLibrary(root: THREE.Object3D): void {
    const placeholders: THREE.InstancedMesh[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && typeof o.userData.library_mesh === 'string') {
        placeholders.push(o);
      }
    });
    for (const placeholder of placeholders) {
      const name = placeholder.userData.library_mesh as string;
      const entry = this.library?.get(name);
      if (!entry || !placeholder.parent) {
        console.warn(`共用網格庫缺少 ${name}`);
        continue;
      }
      if (entry.matrix) {
        const m = new THREE.Matrix4();
        for (let i = 0; i < placeholder.count; i++) {
          placeholder.getMatrixAt(i, m);
          placeholder.setMatrixAt(i, m.multiply(entry.matrix));
        }
      }
      const holder = new THREE.Group();
      holder.name = placeholder.name;
      holder.userData = { ...placeholder.userData };
      holder.position.copy(placeholder.position);
      holder.quaternion.copy(placeholder.quaternion);
      holder.scale.copy(placeholder.scale);
      for (const part of entry.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, placeholder.count);
        mesh.instanceMatrix = placeholder.instanceMatrix;
        mesh.name = name;
        holder.add(mesh);
      }
      placeholder.parent.add(holder);
      placeholder.removeFromParent();
      placeholder.geometry.dispose();
      (placeholder.material as THREE.Material).dispose();
    }
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
      this.resolveLibrary(group);
      await this.applySharedTextures(group);
      if (this.disposed) {
        disposeObject(group);
        return;
      }
      const terrain = entry.chunk.id.startsWith('terrain');
      group.traverse((o) => {
        if (o instanceof THREE.Mesh && this.replaceMaterial?.(o)) {
          return;
        }
        if (o instanceof THREE.Mesh) {
          const transparent = Array.isArray(o.material) ? o.material.some((m) => m.transparent) : o.material.transparent;
          o.userData.castShadow = !terrain && !transparent;
          o.castShadow = this.shadows.cast && o.userData.castShadow === true;
          o.receiveShadow = !transparent;
        }
      });
      group.updateMatrixWorld(true);
      const lods = collectLods(group);
      entry.lodGroups = lods.objects;
      entry.instancedLods = lods.instanced;
      entry.group = group;
      entry.state = 'loaded';
      entry.loadMs = performance.now() - started;
      entry.loadedAt = performance.now();
      this.bytesLoaded += entry.chunk.byteLength ?? 0;
      this.root.add(group);
      // 新分塊的實例要立刻依目前位置分配
      this.lastLodFocus.set(Infinity, 0, Infinity);
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
    entry.instancedLods = [];
    if (entry.state === 'loaded') {
      entry.state = 'idle';
    }
  }

  private updateLods(focus: THREE.Vector3, force: boolean): void {
    const scale = this.distanceScale;
    for (const entry of this.entries) {
      for (const lod of entry.lodGroups) {
        const d = horizontalDistanceToBox(lod.box, focus);
        let level = lod.distances.findIndex((limit) => d < limit * scale);
        if (level === -1) {
          level = lod.levels.length - 1;
        }
        lod.levels.forEach((obj, i) => {
          obj.visible = i === level;
        });
      }
    }
    const moved = Math.hypot(focus.x - this.lastLodFocus.x, focus.z - this.lastLodFocus.z);
    if (!force && moved < INSTANCE_LOD_STEP && scale === this.lastLodScale) {
      return;
    }
    this.lastLodFocus.copy(focus);
    this.lastLodScale = scale;
    let visible = 0;
    for (const entry of this.entries) {
      for (const lod of entry.instancedLods) {
        visible += distributeInstances(lod, focus, scale);
      }
    }
    this.visibleInstances = visible;
  }
}

/**
 * 葉片卡（材質 extras.frontline_foliage）：
 * - 法線改成從樹冠中心往外（混合原本的法線），雙面葉片的背面不會變黑，樹冠像一團受光的體積；
 * - 不依正反面翻轉法線；
 * - 以貼圖本身當自發光的一小部分，近似葉片透光。
 */
function prepareFoliage(parts: LibraryPart[]): void {
  for (const part of parts) {
    const materials = Array.isArray(part.material) ? part.material : [part.material];
    const material = materials[0] as THREE.MeshStandardMaterial | undefined;
    if (!material?.userData.frontline_foliage || part.geometry.userData.foliagePrepared) {
      continue;
    }
    part.geometry.userData.foliagePrepared = true;
    const geometry = part.geometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    if (!position) {
      continue;
    }
    geometry.computeBoundingBox();
    const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
    // 中心稍微往下，樹冠下緣的法線也朝外而不是朝下
    center.y -= (geometry.boundingBox!.max.y - geometry.boundingBox!.min.y) * 0.15;
    const out = new Float32Array(position.count * 3);
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).sub(center).normalize();
      if (normal) {
        n.fromBufferAttribute(normal, i).normalize();
        p.lerp(n, 0.3).normalize();
      }
      out.set([p.x, p.y, p.z], i * 3);
    }
    geometry.setAttribute('normal', new THREE.BufferAttribute(out, 3));
    for (const m of materials as THREE.MeshStandardMaterial[]) {
      m.emissive = new THREE.Color(0.22, 0.24, 0.18);
      m.emissiveMap = m.map;
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_begin>',
          THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'),
        );
      };
      m.customProgramCacheKey = () => 'frontline-foliage';
      m.needsUpdate = true;
    }
  }
}

function horizontalDistanceToBox(box: THREE.Box3, p: THREE.Vector3): number {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return Math.hypot(dx, dz);
}

/** 依每個實例與玩家的水平距離分配到各層級；超過 cull 的不畫。回傳畫出的實例數。 */
function distributeInstances(lod: InstancedLod, focus: THREE.Vector3, scale: number): number {
  const counts = lod.levels.map(() => 0);
  const n = lod.all.length / 16;
  const cull = lod.cull !== undefined ? lod.cull * scale : Infinity;
  const last = lod.levels.length - 1;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const d = Math.hypot(lod.all[o + 12]! - focus.x, lod.all[o + 14]! - focus.z);
    if (d > cull) {
      continue;
    }
    let level = 0;
    while (level < last && d >= lod.distances[level]! * scale) {
      level++;
    }
    const dst = lod.levels[level]!.attr.array as Float32Array;
    const at = counts[level]! * 16;
    for (let k = 0; k < 16; k++) {
      dst[at + k] = lod.all[o + k]!;
    }
    counts[level]!++;
  }
  let visible = 0;
  lod.levels.forEach((level, i) => {
    level.attr.needsUpdate = true;
    for (const mesh of level.meshes) {
      mesh.count = counts[i]!;
    }
    visible += counts[i]!;
  });
  return visible;
}

const instancedMeshesOf = (o: THREE.Object3D): THREE.InstancedMesh[] =>
  o instanceof THREE.InstancedMesh ? [o] : o.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);

/**
 * 依 map-build 寫入的 extras（lod_group、lod_level、lod_distances、cull_distance）建立 LOD。
 * 各層級都是實例數相同的 InstancedMesh 時用逐實例 LOD，否則整個物件切換。
 */
function collectLods(root: THREE.Object3D): { objects: ObjectLod[]; instanced: InstancedLod[] } {
  const groups = new Map<string, { levels: THREE.Object3D[]; distances: number[]; cull: number | undefined }>();
  let anonymous = 0;
  root.traverse((o) => {
    const data = o.userData as { lod_group?: string; lod_level?: number; lod_distances?: number[]; cull_distance?: number };
    const hasLod = typeof data.lod_group === 'string' && typeof data.lod_level === 'number';
    if (!hasLod && typeof data.cull_distance !== 'number') {
      return;
    }
    const key = hasLod ? data.lod_group! : `#cull${anonymous++}`;
    let group = groups.get(key);
    if (!group) {
      group = { levels: [], distances: data.lod_distances ?? DEFAULT_LOD_DISTANCES, cull: undefined };
      groups.set(key, group);
    }
    group.levels[hasLod ? data.lod_level! : 0] = o;
    if (typeof data.cull_distance === 'number') {
      group.cull = data.cull_distance;
    }
  });
  const objects: ObjectLod[] = [];
  const instanced: InstancedLod[] = [];
  for (const group of groups.values()) {
    const levels = group.levels.filter(Boolean);
    const meshes = levels.map(instancedMeshesOf);
    const count = meshes[0]?.[0]?.count;
    const allInstanced = count !== undefined && meshes.every((list) => list.length > 0 && list.every((m) => m.count === count));
    if (allInstanced) {
      const source = meshes[0]![0]!;
      const all = Float32Array.from((source.instanceMatrix.array as Float32Array).subarray(0, count * 16));
      instanced.push({
        all,
        distances: group.distances,
        cull: group.cull,
        levels: meshes.map((list) => {
          const attr = new THREE.InstancedBufferAttribute(Float32Array.from(all), 16);
          attr.setUsage(THREE.DynamicDrawUsage);
          for (const mesh of list) {
            mesh.instanceMatrix = attr;
            mesh.count = count;
            // 以全部實例計算包圍球；之後只改 count，不再重算
            mesh.computeBoundingSphere();
          }
          for (const level of levels) {
            level.visible = true;
          }
          return { meshes: list, attr };
        }),
      });
    } else if (levels.length > 1) {
      const box = new THREE.Box3();
      for (const level of levels) {
        box.expandByObject(level);
      }
      objects.push({ box, levels, distances: group.distances });
    }
  }
  return { objects, instanced };
}

/** 釋放物件的 GPU 資源；標記 userData.shared 的共用資源只在 includeShared 時釋放。 */
export function disposeObject(root: THREE.Object3D, includeShared = false): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (includeShared || !o.geometry.userData.shared) {
        o.geometry.dispose();
      }
      const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
      for (const material of materials) {
        if (!includeShared && material.userData.shared) {
          continue;
        }
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture && !value.userData.shared) {
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
