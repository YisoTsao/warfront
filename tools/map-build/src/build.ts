import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Document, ImageUtils, Logger, NodeIO, type Material, type Mesh, type Node, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { cloneDocument, dedup, meshopt, prune } from '@gltf-transform/functions';
import {
  MAP_SCHEMA_VERSION,
  matchRole,
  parseLodName,
  parseMapCollision,
  parseMapManifest,
  roleCategory,
  type CollectionRole,
  type ColliderData,
  type CollisionLayer,
  type MapChunk,
  type MapCollision,
  type MapEnvironment,
  type MapManifest,
} from '@frontline/map-schema';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { column, emptyBox, expand, isEmptyBox, len, quatFromAxes, rotate, round, transformPoint, unionBox, type Box3, type V3 } from './math';

export interface BuildOptions {
  input: string;
  outDir: string;
  id: string;
  name: string;
  /** 細節分塊邊長（公尺） */
  chunkSize?: number;
  /** 使用 Meshopt 壓縮幾何（預設開啟） */
  compress?: boolean;
  /** 同一網格出現至少幾次才合併成 GPU instancing */
  instanceMin?: number;
  /** LOD 切換距離（公尺），依層級排列 */
  lodDistances?: number[];
  /** 細節分塊的串流距離（公尺），預設為 chunkSize × 2.5 */
  streamDistance?: number;
  /**
   * 貼圖另存到 textures/，分塊材質只記錄路徑（extras.frontline_textures），
   * 前端以快取共用同一張貼圖。預設開啟；關閉則把貼圖嵌在每個分塊裡。
   */
  sharedTextures?: boolean;
  /**
   * 重複出現的網格（含其 LOD）只寫一次到 library.glb，分塊只存放實例變換。
   * 也可以在來源場景的 frontline_build.shared_library 開啟。
   */
  sharedLibrary?: boolean;
  log?: (message: string) => void;
}

export interface BuildReport {
  manifestPath: string;
  chunks: Array<{ id: string; bytes: number; nodes: number; instancedGroups: number }>;
  textures: Array<{ path: string; bytes: number }>;
  library: { path: string; bytes: number; meshes: number } | null;
  colliders: { boxes: number; trimeshes: number; triangles: number; heightfields: number };
  spawns: number;
  objectives: number;
  warnings: string[];
}

interface Classified {
  node: Node;
  index: number;
  role: CollectionRole;
}

const DEFAULT_ENVIRONMENT: MapEnvironment = {
  skyColor: '#a9bccb',
  fogColor: '#b4c3cc',
  fogNear: 60,
  fogFar: 300,
  sunDirection: [-0.45, -0.75, -0.48],
  sunColor: '#fff1dc',
  sunIntensity: 2.4,
  hemisphereSky: '#dfe8f2',
  hemisphereGround: '#4a4a3a',
  hemisphereIntensity: 1,
};

function createIO(): NodeIO {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}

/** 節點自己或祖先的角色。只看名稱前綴與 frontline_role 屬性。 */
function roleOf(node: Node): CollectionRole | null {
  let current: Node | null = node;
  while (current) {
    const role = matchRole(current.getName(), current.getExtras());
    if (role) {
      return role;
    }
    current = current.getParentNode();
  }
  return null;
}

/** 節點本身就是集合（頂層 empty），而不是集合內的物件。 */
function isCollectionNode(node: Node): boolean {
  return matchRole(node.getName()) !== null && node.getMesh() === null && node.listChildren().length > 0;
}

function meshLocalBounds(mesh: Mesh): Box3 {
  const box = emptyBox();
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    if (!position) {
      continue;
    }
    const element: number[] = [];
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, element);
      expand(box, element);
    }
  }
  return box;
}

function worldBounds(node: Node): Box3 {
  const mesh = node.getMesh();
  const box = emptyBox();
  if (!mesh) {
    expand(box, node.getWorldTranslation());
    return box;
  }
  const local = meshLocalBounds(mesh);
  const m = node.getWorldMatrix();
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        expand(box, transformPoint(m, [x, y, z]));
      }
    }
  }
  return box;
}

function yawFromRotation(q: readonly number[]): number {
  const forward = rotate(q, [0, 0, -1]);
  return Math.atan2(-forward[0], -forward[2]);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function teamFrom(node: Node): 'alpha' | 'bravo' | undefined {
  const explicit = str(node.getExtras().team)?.toLowerCase();
  if (explicit === 'alpha' || explicit === 'bravo') {
    return explicit;
  }
  const name = node.getName().toLowerCase();
  if (name.includes('alpha')) {
    return 'alpha';
  }
  return name.includes('bravo') ? 'bravo' : undefined;
}

/** empty 的立方體顯示範圍：中心為位置，半尺寸為世界縮放。 */
function volumeBounds(node: Node): { min: V3; max: V3 } {
  const t = node.getWorldTranslation();
  const s = node.getWorldScale();
  return {
    min: [round(t[0] - Math.abs(s[0])), round(t[1] - Math.abs(s[1])), round(t[2] - Math.abs(s[2]))],
    max: [round(t[0] + Math.abs(s[0])), round(t[1] + Math.abs(s[1])), round(t[2] + Math.abs(s[2]))],
  };
}

function colliderFromNode(node: Node, role: CollectionRole, warnings: string[]): ColliderData | null {
  const mesh = node.getMesh();
  if (!mesh) {
    return null;
  }
  const extras = node.getExtras();
  const layerExtra = str(extras.layer);
  const layer: CollisionLayer =
    role === 'COLLISION_Bullet' ? 'bullet' : layerExtra === 'movement' || layerExtra === 'bullet' ? layerExtra : 'both';
  const material = str(extras.material);
  const m = node.getWorldMatrix();
  if (extras.collider === 'heightfield') {
    return heightfieldFromNode(node, layer, material, warnings);
  }
  const wantsBox = extras.collider === 'box' || /^(UBX|BOX)_/i.test(node.getName());
  if (wantsBox) {
    const local = meshLocalBounds(mesh);
    if (isEmptyBox(local)) {
      warnings.push(`碰撞物件 ${node.getName()} 沒有頂點，已略過`);
      return null;
    }
    const localCenter: V3 = [(local.min[0] + local.max[0]) / 2, (local.min[1] + local.max[1]) / 2, (local.min[2] + local.max[2]) / 2];
    const center = transformPoint(m, localCenter);
    const axes = [column(m, 0), column(m, 1), column(m, 2)] as const;
    const scales = axes.map(len);
    const unit = axes.map((a, i) => [a[0] / scales[i]!, a[1] / scales[i]!, a[2] / scales[i]!] as V3);
    const half: V3 = [0, 1, 2].map((i) => round(((local.max[i]! - local.min[i]!) / 2) * scales[i]!)) as V3;
    const rotation = quatFromAxes(unit[0]!, unit[1]!, unit[2]!).map((v) => round(v, 6)) as [number, number, number, number];
    return {
      kind: 'box',
      name: node.getName(),
      center: center.map((v) => round(v)) as V3,
      halfExtents: half,
      rotation,
      layer,
      ...(material ? { material } : {}),
    };
  }
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    if (!position) {
      continue;
    }
    const base = vertices.length / 3;
    const element: number[] = [];
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, element);
      vertices.push(...transformPoint(m, element).map((v) => round(v)));
    }
    const idx = prim.getIndices();
    if (idx) {
      for (let i = 0; i < idx.getCount(); i++) {
        indices.push(idx.getScalar(i) + base);
      }
    } else {
      for (let i = 0; i < position.getCount(); i++) {
        indices.push(base + i);
      }
    }
  }
  if (indices.length === 0) {
    return null;
  }
  return { kind: 'trimesh', name: node.getName(), vertices, indices, layer, ...(material ? { material } : {}) };
}

/**
 * 規則格狀網格 → 高度場。頂點必須依列優先排列（列沿 +Z、欄沿 +X），
 * 自訂屬性 grid_rows / grid_cols 指定樣本數。
 */
function heightfieldFromNode(node: Node, layer: CollisionLayer, material: string | undefined, warnings: string[]): ColliderData | null {
  const extras = node.getExtras();
  const rows = num(extras.grid_rows);
  const cols = num(extras.grid_cols);
  const position = node.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION');
  if (!rows || !cols || !position || position.getCount() !== rows * cols) {
    warnings.push(`高度場 ${node.getName()} 需要 grid_rows × grid_cols 個頂點（列優先），已略過`);
    return null;
  }
  const m = node.getWorldMatrix();
  const element: number[] = [];
  const world = (i: number): V3 => {
    position.getElement(i, element);
    return transformPoint(m, element);
  };
  const first = world(0);
  const lastCol = world(cols - 1);
  const lastRow = world((rows - 1) * cols);
  const size: [number, number] = [lastCol[0] - first[0], lastRow[2] - first[2]];
  if (!(size[0] > 0 && size[1] > 0)) {
    warnings.push(`高度場 ${node.getName()} 的頂點順序不是列沿 +Z、欄沿 +X，已略過`);
    return null;
  }
  const heights: number[] = new Array(rows * cols);
  const tolerance = Math.min(size[0] / (cols - 1), size[1] / (rows - 1)) * 0.01;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = world(r * cols + c);
      const ex = first[0] + (size[0] * c) / (cols - 1);
      const ez = first[2] + (size[1] * r) / (rows - 1);
      if (Math.abs(p[0] - ex) > tolerance || Math.abs(p[2] - ez) > tolerance) {
        warnings.push(`高度場 ${node.getName()} 不是規則格狀（第 ${r} 列第 ${c} 欄偏移），已略過`);
        return null;
      }
      heights[r * cols + c] = round(p[1], 3);
    }
  }
  return {
    kind: 'heightfield',
    name: node.getName(),
    origin: [round(first[0], 4), round(first[2], 4)],
    size: [round(size[0], 4), round(size[1], 4)],
    rows,
    cols,
    heights,
    layer,
    ...(material ? { material } : {}),
  };
}

function hexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function environmentFrom(nodes: Classified[]): MapEnvironment {
  const sun = nodes.find((c) => c.role === 'LIGHTING_Reference' && /sun/i.test(c.node.getName()));
  if (!sun) {
    return DEFAULT_ENVIRONMENT;
  }
  const e = sun.node.getExtras();
  const dir = rotate(sun.node.getWorldRotation(), [0, 0, -1]);
  return {
    skyColor: hexColor(e.sky_color, DEFAULT_ENVIRONMENT.skyColor),
    fogColor: hexColor(e.fog_color, DEFAULT_ENVIRONMENT.fogColor),
    fogNear: num(e.fog_near) ?? DEFAULT_ENVIRONMENT.fogNear,
    fogFar: num(e.fog_far) ?? DEFAULT_ENVIRONMENT.fogFar,
    sunDirection: dir.map((v) => round(v, 4)) as V3,
    sunColor: hexColor(e.sun_color, DEFAULT_ENVIRONMENT.sunColor),
    sunIntensity: num(e.sun_intensity) ?? DEFAULT_ENVIRONMENT.sunIntensity,
    hemisphereSky: hexColor(e.hemisphere_sky, DEFAULT_ENVIRONMENT.hemisphereSky),
    hemisphereGround: hexColor(e.hemisphere_ground, DEFAULT_ENVIRONMENT.hemisphereGround),
    hemisphereIntensity: num(e.hemisphere_intensity) ?? DEFAULT_ENVIRONMENT.hemisphereIntensity,
  };
}

/**
 * 在分塊文件裡，把共用同一網格的物件合併成 EXT_mesh_gpu_instancing；
 * 名稱為 X_LOD0 的網格若有 X_LOD1，另外建立一組共用同樣變換的 LOD1 節點。
 *
 * library 不為 null 時，名單內的網格一律合併（即使只有 1 個），節點改掛一個極小的佔位網格，
 * 並在 extras.library_mesh 記錄網格名稱；前端從 library.glb 取得共用的幾何與材質。
 */
function instanceAndLod(doc: Document, minCount: number, lodDistances: number[], library: Set<string> | null): number {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) {
    return 0;
  }
  const meshesByName = new Map(doc.getRoot().listMeshes().map((m) => [m.getName(), m]));
  const groups = new Map<Mesh, Node[]>();
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (mesh && node.listChildren().length === 0) {
      const list = groups.get(mesh) ?? [];
      list.push(node);
      groups.set(mesh, list);
    }
  }
  const ext = doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
  const buffer = doc.getRoot().listBuffers()[0];
  let placeholder: Mesh | null = null;
  const placeholderMesh = (): Mesh => {
    // 包圍盒剛好是 [-1, 1]：Meshopt 量化時的修正變換為單位矩陣，不會改到實例變換
    placeholder ??= doc
      .createMesh('library_placeholder')
      .addPrimitive(
        doc
          .createPrimitive()
          .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1, 1])).setBuffer(buffer ?? null)),
      );
    return placeholder;
  };
  let instanced = 0;
  for (const [mesh, nodes] of groups) {
    const fromLibrary = library?.has(mesh.getName()) ?? false;
    const lod = parseLodName(mesh.getName());
    const lodMeshes: Mesh[] = [mesh];
    if (lod?.level === 0) {
      for (let level = 1; level < 4; level++) {
        const next = meshesByName.get(`${lod.base}_LOD${level}`);
        if (!next) {
          break;
        }
        lodMeshes.push(next);
      }
    }
    const lodExtras = (level: number) =>
      lod && lodMeshes.length > 1 ? { lod_group: lod.base, lod_level: level, lod_distances: lodDistances.slice(0, lodMeshes.length - 1) } : {};
    const cullDistance = num(mesh.getExtras().cull_distance);

    if (!fromLibrary && nodes.length < minCount) {
      // 不合併，但仍為 LOD 建立兄弟節點
      if (lodMeshes.length > 1) {
        for (const node of nodes) {
          node.setExtras({ ...node.getExtras(), ...lodExtras(0), lod_group: `${lod!.base}#${node.getName()}` });
          for (let level = 1; level < lodMeshes.length; level++) {
            const sibling = doc
              .createNode(`${node.getName()}_LOD${level}`)
              .setMesh(lodMeshes[level]!)
              .setMatrix(node.getMatrix())
              .setExtras({ ...lodExtras(level), lod_group: `${lod!.base}#${node.getName()}` });
            scene.addChild(sibling);
          }
        }
      }
      continue;
    }
    const translations = new Float32Array(nodes.length * 3);
    const rotations = new Float32Array(nodes.length * 4);
    const scales = new Float32Array(nodes.length * 3);
    nodes.forEach((node, i) => {
      translations.set(node.getTranslation(), i * 3);
      rotations.set(node.getRotation(), i * 4);
      scales.set(node.getScale(), i * 3);
    });
    const accessors = {
      TRANSLATION: doc.createAccessor().setType('VEC3').setArray(translations).setBuffer(buffer ?? null),
      ROTATION: doc.createAccessor().setType('VEC4').setArray(rotations).setBuffer(buffer ?? null),
      SCALE: doc.createAccessor().setType('VEC3').setArray(scales).setBuffer(buffer ?? null),
    };
    lodMeshes.forEach((lodMesh, level) => {
      const batch = ext
        .createInstancedMesh()
        .setAttribute('TRANSLATION', accessors.TRANSLATION)
        .setAttribute('ROTATION', accessors.ROTATION)
        .setAttribute('SCALE', accessors.SCALE);
      const node = doc
        .createNode(lodMesh.getName())
        .setMesh(fromLibrary ? placeholderMesh() : lodMesh)
        .setExtension('EXT_mesh_gpu_instancing', batch)
        .setExtras({
          instance_count: nodes.length,
          ...lodExtras(level),
          ...(fromLibrary ? { library_mesh: lodMesh.getName() } : {}),
          ...(cullDistance ? { cull_distance: cullDistance } : {}),
        });
      scene.addChild(node);
    });
    for (const node of nodes) {
      node.dispose();
    }
    instanced++;
  }
  if (instanced === 0) {
    ext.dispose();
  }
  return instanced;
}

/** 共用網格庫：每個網格（含 LOD）一個節點，放在原點。 */
async function writeLibrary(source: Document, names: Set<string>, outDir: string, compress: boolean, textures: Map<string, number>): Promise<{ path: string; bytes: number; meshes: number }> {
  const io = createIO();
  const doc = cloneDocument(source);
  doc.setLogger(new Logger(Logger.Verbosity.ERROR));
  const root = doc.getRoot();
  for (const scn of root.listScenes()) {
    scn.dispose();
  }
  for (const node of root.listNodes()) {
    node.dispose();
  }
  const scene = doc.createScene('library');
  root.setDefaultScene(scene);
  let meshes = 0;
  for (const mesh of root.listMeshes()) {
    if (names.has(mesh.getName())) {
      scene.addChild(doc.createNode(mesh.getName()).setMesh(mesh).setExtras({ library_mesh: mesh.getName() }));
      meshes++;
    }
  }
  await doc.transform(prune({ keepLeaves: false }), dedup());
  externalizeTextures(doc, outDir, textures);
  // 貼圖已移到外部：保留 UV 等頂點屬性（否則 prune 會當作沒用到而刪掉）
  await doc.transform(prune({ keepLeaves: false, keepAttributes: true }));
  if (compress) {
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  }
  const glb = await io.writeBinary(doc);
  writeFileSync(join(outDir, 'library.glb'), glb);
  return { path: 'library.glb', bytes: glb.byteLength, meshes };
}

const TEXTURE_SLOTS = [
  ['map', (m: Material) => m.getBaseColorTexture(), (m: Material) => m.setBaseColorTexture(null)],
  ['normalMap', (m: Material) => m.getNormalTexture(), (m: Material) => m.setNormalTexture(null)],
  ['roughnessMap', (m: Material) => m.getMetallicRoughnessTexture(), (m: Material) => m.setMetallicRoughnessTexture(null)],
  ['aoMap', (m: Material) => m.getOcclusionTexture(), (m: Material) => m.setOcclusionTexture(null)],
  ['emissiveMap', (m: Material) => m.getEmissiveTexture(), (m: Material) => m.setEmissiveTexture(null)],
] as const;

/** 把一張圖寫到 textures/（依內容雜湊命名），回傳相對路徑。 */
function writeTextureFile(outDir: string, name: string, image: Uint8Array, mime: string, written: Map<string, number>): string {
  const ext = ImageUtils.mimeTypeToExtension(mime);
  const base = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'texture';
  const path = `textures/${base}-${createHash('sha1').update(image).digest('hex').slice(0, 10)}.${ext}`;
  if (!written.has(path)) {
    const file = join(outDir, path);
    if (!existsSync(file)) {
      mkdirSync(join(outDir, 'textures'), { recursive: true });
      writeFileSync(file, image);
    }
    written.set(path, image.byteLength);
  }
  return path;
}

/**
 * 來源場景的 extras.frontline_water 指定流向圖與水深圖（以貼圖名稱指向 GLB 內的圖），
 * 寫到 textures/ 並轉成 manifest.water。
 */
function waterSurfaceFrom(source: Document, settings: Record<string, unknown> | undefined, outDir: string, written: Map<string, number>, warnings: string[]): MapManifest['water'] {
  if (!settings) {
    return undefined;
  }
  const textures = source.getRoot().listTextures();
  const image = (name: unknown) => {
    const texture = textures.find((t) => t.getName() === name);
    return texture?.getImage() ? { image: texture.getImage()!, mime: texture.getMimeType() || 'image/png', name: texture.getName() } : null;
  };
  const flow = image(settings.flow_texture);
  const depth = image(settings.depth_texture);
  const origin = settings.origin;
  const size = num(settings.size);
  const maxDepth = num(settings.max_depth);
  const maxSpeed = num(settings.max_speed);
  if (!flow || !depth || !Array.isArray(origin) || origin.length !== 2 || !size || !maxDepth || !maxSpeed) {
    warnings.push('frontline_water 設定不完整（需要 flow_texture、depth_texture、origin、size、max_depth、max_speed），已略過水面資料');
    return undefined;
  }
  return {
    flowMap: writeTextureFile(outDir, flow.name, flow.image, flow.mime, written),
    depthMap: writeTextureFile(outDir, depth.name, depth.image, depth.mime, written),
    origin: [Number(origin[0]), Number(origin[1])],
    size,
    maxDepth,
    maxSpeed,
  };
}

/**
 * 來源場景的 extras.frontline_grass 指定草地密度圖與顏色貼圖（以貼圖名稱指向 GLB 內的圖），
 * 寫到 textures/ 並轉成 manifest.grass。顏色貼圖通常就是地形底色，依內容雜湊命名所以不會多寫一份。
 */
function grassFieldFrom(source: Document, settings: Record<string, unknown> | undefined, outDir: string, written: Map<string, number>, warnings: string[]): MapManifest['grass'] {
  if (!settings) {
    return undefined;
  }
  const textures = source.getRoot().listTextures();
  const image = (name: unknown) => {
    const texture = textures.find((t) => t.getName() === name);
    return texture?.getImage() ? { image: texture.getImage()!, mime: texture.getMimeType() || 'image/png', name: texture.getName() } : null;
  };
  const density = image(settings.density_texture);
  const color = settings.color_texture === undefined ? null : image(settings.color_texture);
  const origin = settings.origin;
  const size = num(settings.size);
  if (!density || !Array.isArray(origin) || origin.length !== 2 || !size) {
    warnings.push('frontline_grass 設定不完整（需要 density_texture、origin、size），已略過草地資料');
    return undefined;
  }
  if (settings.color_texture !== undefined && !color) {
    warnings.push(`frontline_grass 的 color_texture「${String(settings.color_texture)}」不存在，草地改用固定顏色`);
  }
  return {
    densityMap: writeTextureFile(outDir, density.name, density.image, density.mime, written),
    ...(color ? { colorMap: writeTextureFile(outDir, color.name, color.image, color.mime, written) } : {}),
    origin: [Number(origin[0]), Number(origin[1])],
    size,
  };
}

/** 依名稱找來源 GLB 內的貼圖 */
function namedImage(source: Document, name: unknown): { image: Uint8Array; mime: string; name: string } | null {
  const texture = source.getRoot().listTextures().find((t) => t.getName() === name);
  return texture?.getImage() ? { image: texture.getImage()!, mime: texture.getMimeType() || 'image/png', name: texture.getName() } : null;
}

/**
 * 來源場景的 extras.frontline_terrain：地形圖層權重圖與各圖層的細節貼圖（以貼圖名稱指向 GLB 內的圖），
 * 寫到 textures/ 並轉成 manifest.terrain。
 */
function terrainSurfaceFrom(source: Document, settings: Record<string, unknown> | undefined, outDir: string, written: Map<string, number>, warnings: string[]): MapManifest['terrain'] {
  if (!settings) {
    return undefined;
  }
  const write = (name: unknown) => {
    const img = namedImage(source, name);
    return img ? writeTextureFile(outDir, img.name, img.image, img.mime, written) : null;
  };
  const splat = write(settings.splat_texture);
  const splat2 = write(settings.splat2_texture);
  const across = write(settings.across_texture);
  const origin = settings.origin;
  const size = num(settings.size);
  const layers = Array.isArray(settings.layers)
    ? (settings.layers as Array<Record<string, unknown>>).map((l) => ({ name: String(l.name), albedo: write(l.albedo), normal: write(l.normal), tile: num(l.tile) }))
    : [];
  if (!splat || !splat2 || !across || !Array.isArray(origin) || origin.length !== 2 || !size || layers.length !== 6 || layers.some((l) => !l.albedo || !l.normal || !l.tile)) {
    warnings.push('frontline_terrain 設定不完整（需要 splat_texture、splat2_texture、across_texture、6 個 layers、origin、size），地形只用底色貼圖');
    return undefined;
  }
  return {
    splatMap: splat,
    splat2Map: splat2,
    acrossMap: across,
    layers: layers.map((l) => ({ name: l.name, albedo: l.albedo!, normal: l.normal!, tile: l.tile! })),
    origin: [Number(origin[0]), Number(origin[1])],
    size,
  };
}

/** 來源場景的 extras.frontline_minimap：小地圖影像，寫到 textures/ 並轉成 manifest.minimap。 */
function minimapFrom(source: Document, settings: Record<string, unknown> | undefined, outDir: string, written: Map<string, number>, warnings: string[]): MapManifest['minimap'] {
  if (!settings) {
    return undefined;
  }
  const img = namedImage(source, settings.texture);
  const origin = settings.origin;
  const size = num(settings.size);
  if (!img || !Array.isArray(origin) || origin.length !== 2 || !size) {
    warnings.push('frontline_minimap 設定不完整（需要 texture、origin、size），已略過小地圖影像');
    return undefined;
  }
  return { image: writeTextureFile(outDir, img.name, img.image, img.mime, written), origin: [Number(origin[0]), Number(origin[1])], size };
}

/**
 * 把材質用到的貼圖寫到 textures/（依內容雜湊命名，同一張只寫一次），
 * 材質改成在 extras.frontline_textures 記錄 { map: 'textures/xxx.png', ... }。
 */
function externalizeTextures(doc: Document, outDir: string, written: Map<string, number>): void {
  const pathOf = (texture: Texture): string | null => {
    const image = texture.getImage();
    if (!image) {
      return null;
    }
    const mime = texture.getMimeType() || ImageUtils.getMimeType(image) || 'image/png';
    const name = texture.getName() || texture.getURI().replace(/\.[a-z0-9]+$/i, '') || 'texture';
    return writeTextureFile(outDir, name, image, mime, written);
  };
  for (const material of doc.getRoot().listMaterials()) {
    const refs: Record<string, string> = {};
    for (const [slot, get, clear] of TEXTURE_SLOTS) {
      const texture = get(material);
      const path = texture ? pathOf(texture) : null;
      if (path) {
        refs[slot] = path;
        clear(material);
      }
    }
    if (Object.keys(refs).length > 0) {
      material.setExtras({ ...material.getExtras(), frontline_textures: refs });
    }
  }
}

export async function buildMap(options: BuildOptions): Promise<BuildReport> {
  const log = options.log ?? (() => undefined);
  const compress = options.compress ?? true;
  const warnings: string[] = [];
  const io = createIO();
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  log(`讀取 ${options.input}`);
  const source = await io.read(options.input);
  const root = source.getRoot();
  // 來源檔可以在場景的自訂屬性 frontline_build 裡指定建置參數；命令列參數優先。
  const sceneSettings = (root.getDefaultScene() ?? root.listScenes()[0])?.getExtras().frontline_build as Record<string, unknown> | undefined;
  const chunkSize = options.chunkSize ?? num(sceneSettings?.chunk_size) ?? 64;
  const terrainChunkSize = Math.max(chunkSize, num(sceneSettings?.terrain_chunk_size) ?? 128);
  const streamDistance = options.streamDistance ?? num(sceneSettings?.stream_distance) ?? chunkSize * 2.5;
  const lodSetting = sceneSettings?.lod_distances;
  const lodDistances =
    options.lodDistances ?? (Array.isArray(lodSetting) && lodSetting.every((v) => typeof v === 'number') ? (lodSetting as number[]) : [70, 160]);
  const sharedTextures = options.sharedTextures ?? true;
  const useLibrary = options.sharedLibrary ?? sceneSettings?.shared_library === true;
  const textureFiles = new Map<string, number>();
  const allNodes = root.listNodes();
  const classified: Classified[] = [];
  allNodes.forEach((node, index) => {
    const role = roleOf(node);
    if (role && !isCollectionNode(node)) {
      classified.push({ node, index, role });
    }
  });
  const unassigned = allNodes.filter((n) => n.getMesh() && !roleOf(n));
  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} 個有網格的物件不在任何 ENV_/COLLISION_/GAMEPLAY_ 集合內，已略過（例如 ${unassigned[0]!.getName()}）`);
  }

  // ---- 遊戲標記 ----
  const spawns: MapManifest['spawns'] = [];
  const objectives: MapManifest['objectives'] = [];
  const restrictedAreas: MapManifest['restrictedAreas'] = [];
  const waterVolumes: MapManifest['waterVolumes'] = [];
  for (const { node, role } of classified) {
    const extras = node.getExtras();
    const t = node.getWorldTranslation().map((v) => round(v)) as V3;
    switch (role) {
      case 'GAMEPLAY_SpawnPoints': {
        const team = teamFrom(node);
        const yawDegrees = num(extras.yaw_degrees);
        spawns.push({
          id: node.getName(),
          ...(team ? { team } : {}),
          position: t,
          yaw: round(yawDegrees !== undefined ? (yawDegrees * Math.PI) / 180 : yawFromRotation(node.getWorldRotation()), 4),
        });
        break;
      }
      case 'GAMEPLAY_Objectives': {
        const team = str(extras.initial_owner);
        objectives.push({
          id: str(extras.objective_id) ?? node.getName(),
          name: str(extras.display_name) ?? node.getName(),
          position: t,
          radius: round(num(extras.radius) ?? Math.abs(node.getWorldScale()[0])),
          ...(team === 'alpha' || team === 'bravo' ? { initialOwner: team } : {}),
        });
        break;
      }
      case 'GAMEPLAY_RestrictedAreas': {
        const team = teamFrom(node);
        restrictedAreas.push({
          id: node.getName(),
          bounds: volumeBounds(node),
          graceSeconds: num(extras.grace_seconds) ?? 10,
          ...(team ? { team } : {}),
        });
        break;
      }
      case 'GAMEPLAY_WaterVolumes':
        waterVolumes.push({ id: node.getName(), bounds: volumeBounds(node), depth: extras.depth === 'deep' ? 'deep' : 'shallow' });
        break;
      default:
        break;
    }
  }

  // ---- 碰撞 ----
  const colliders: ColliderData[] = [];
  for (const { node, role } of classified) {
    if (roleCategory(role) === 'collision') {
      const collider = colliderFromNode(node, role, warnings);
      if (collider) {
        colliders.push(collider);
      }
    }
  }
  if (colliders.length === 0) {
    throw new Error('找不到任何碰撞物件：請把碰撞網格放在 COLLISION_Static（或 COLLISION_Bullet）集合裡');
  }
  const collision: MapCollision = parseMapCollision({ schemaVersion: 1, colliders });

  // ---- 視覺分塊 ----
  const visual = classified.filter(
    (c) => roleCategory(c.role) === 'visual' && c.node.getMesh() && c.node.getExtras().lod_library !== true,
  );
  let terrainBounds = emptyBox();
  let allBounds = emptyBox();
  const nodeBounds = new Map<number, Box3>();
  for (const c of visual) {
    const b = worldBounds(c.node);
    nodeBounds.set(c.index, b);
    allBounds = unionBox(allBounds, b);
    if (c.role === 'ENV_Terrain') {
      terrainBounds = unionBox(terrainBounds, b);
    }
  }
  if (isEmptyBox(allBounds)) {
    throw new Error('找不到任何視覺物件：請把網格放在 ENV_* 集合裡');
  }
  const mapBounds = isEmptyBox(terrainBounds) ? allBounds : terrainBounds;
  const chunkMembers = new Map<string, { indices: number[]; bounds: Box3; terrain: boolean }>();
  for (const c of visual) {
    const b = nodeBounds.get(c.index)!;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const size = c.role === 'ENV_Terrain' ? terrainChunkSize : chunkSize;
    // 物件包圍盒中心可能稍微超出地圖（例如邊緣的樹冠偏一側），夾回地圖內的分塊，不另外產生一個分塊
    const cols = Math.max(1, Math.ceil((mapBounds.max[0] - mapBounds.min[0]) / size));
    const rows = Math.max(1, Math.ceil((mapBounds.max[2] - mapBounds.min[2]) / size));
    const ix = Math.min(cols - 1, Math.max(0, Math.floor((cx - mapBounds.min[0]) / size)));
    const iz = Math.min(rows - 1, Math.max(0, Math.floor((cz - mapBounds.min[2]) / size)));
    const id = `${c.role === 'ENV_Terrain' ? 'terrain' : 'detail'}-${ix}-${iz}`;
    const entry = chunkMembers.get(id) ?? { indices: [], bounds: emptyBox(), terrain: c.role === 'ENV_Terrain' };
    entry.indices.push(c.index);
    entry.bounds = unionBox(entry.bounds, b);
    chunkMembers.set(id, entry);
  }

  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(join(options.outDir, 'chunks'), { recursive: true });

  // ---- 共用網格庫 ----
  let libraryNames: Set<string> | null = null;
  let library: BuildReport['library'] = null;
  if (useLibrary) {
    const usage = new Map<Mesh, number>();
    for (const c of visual) {
      const mesh = c.node.getMesh();
      if (mesh && c.role !== 'ENV_Terrain' && c.node.listChildren().length === 0) {
        usage.set(mesh, (usage.get(mesh) ?? 0) + 1);
      }
    }
    libraryNames = new Set([...usage].filter(([, n]) => n >= 2).map(([m]) => m.getName()));
    const byName = new Set(root.listMeshes().map((m) => m.getName()));
    for (const name of [...libraryNames]) {
      const lod = parseLodName(name);
      for (let level = 1; lod?.level === 0 && level < 4 && byName.has(`${lod.base}_LOD${level}`); level++) {
        libraryNames.add(`${lod.base}_LOD${level}`);
      }
    }
    library = await writeLibrary(source, libraryNames, options.outDir, compress, textureFiles);
    log(`共用網格庫：${library.meshes} 個網格、${(library.bytes / 1024).toFixed(0)} KB`);
  }
  const chunks: MapChunk[] = [];
  const chunkReports: BuildReport['chunks'] = [];
  for (const [id, entry] of [...chunkMembers].sort(([a], [b]) => a.localeCompare(b))) {
    const doc = cloneDocument(source);
    doc.setLogger(new Logger(Logger.Verbosity.ERROR));
    const nodes = doc.getRoot().listNodes();
    const keep = new Set(entry.indices);
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]!;
    const kept = entry.indices.map((i) => nodes[i]!);
    const matrices = kept.map((n) => n.getWorldMatrix());
    for (const child of scene.listChildren()) {
      scene.removeChild(child);
    }
    for (const scn of doc.getRoot().listScenes()) {
      if (scn !== scene) {
        scn.dispose();
      }
    }
    kept.forEach((node, i) => {
      for (const child of node.listChildren()) {
        node.removeChild(child);
      }
      node.getParentNode()?.removeChild(node);
      node.setMatrix(matrices[i]!);
      scene.addChild(node);
    });
    nodes.forEach((node, i) => {
      if (!keep.has(i) && node.getMesh() && !kept.includes(node)) {
        // 保留網格給 LOD 使用，節點本身移除
        node.dispose();
      }
    });
    const instancedGroups = instanceAndLod(doc, options.instanceMin ?? 4, lodDistances, libraryNames);
    await doc.transform(prune({ keepLeaves: false }), dedup());
    if (sharedTextures) {
      externalizeTextures(doc, options.outDir, textureFiles);
      await doc.transform(prune({ keepLeaves: false, keepAttributes: true }));
    }
    if (compress) {
      await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    }
    const glb = await io.writeBinary(doc);
    const path = `chunks/${id}.glb`;
    writeFileSync(join(options.outDir, path), glb);
    const bounds = {
      min: entry.bounds.min.map((v) => round(v, 2)) as V3,
      max: entry.bounds.max.map((v) => round(v, 2)) as V3,
    };
    chunks.push({
      id,
      path,
      bounds,
      priority: entry.terrain ? 0 : 1,
      ...(entry.terrain ? {} : { streamDistance: round(streamDistance) }),
      byteLength: glb.byteLength,
    });
    chunkReports.push({ id, bytes: glb.byteLength, nodes: entry.indices.length, instancedGroups });
    log(`分塊 ${id}：${entry.indices.length} 個物件、${instancedGroups} 組 instancing、${(glb.byteLength / 1024).toFixed(0)} KB`);
  }

  // ---- 水面 ----
  const sceneExtras = (root.getDefaultScene() ?? root.listScenes()[0])?.getExtras();
  const water = waterSurfaceFrom(source, sceneExtras?.frontline_water as Record<string, unknown> | undefined, options.outDir, textureFiles, warnings);
  const grass = grassFieldFrom(source, sceneExtras?.frontline_grass as Record<string, unknown> | undefined, options.outDir, textureFiles, warnings);
  const terrainSurface = terrainSurfaceFrom(source, sceneExtras?.frontline_terrain as Record<string, unknown> | undefined, options.outDir, textureFiles, warnings);
  const minimap = minimapFrom(source, sceneExtras?.frontline_minimap as Record<string, unknown> | undefined, options.outDir, textureFiles, warnings);

  // ---- manifest ----
  const minY = Math.min(
    mapBounds.min[1],
    ...collision.colliders.flatMap((c) =>
      c.kind === 'box' ? [c.center[1] - c.halfExtents[1]] : c.kind === 'heightfield' ? [c.heights.reduce((a, b) => Math.min(a, b), Infinity)] : [],
    ),
  );
  const manifest: MapManifest = parseMapManifest({
    schemaVersion: MAP_SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    bounds: {
      min: [round(mapBounds.min[0]), round(minY - 10), round(mapBounds.min[2])],
      max: [round(mapBounds.max[0]), round(mapBounds.max[1] + 60), round(mapBounds.max[2])],
    },
    killPlaneY: round(minY - 25),
    environment: environmentFrom(classified),
    chunks,
    collision: 'collision.json',
    ...(library ? { library: { path: library.path, byteLength: library.bytes } } : {}),
    ...(water ? { water } : {}),
    ...(grass ? { grass } : {}),
    ...(terrainSurface ? { terrain: terrainSurface } : {}),
    ...(minimap ? { minimap } : {}),
    spawns,
    objectives,
    restrictedAreas,
    waterVolumes,
    source: {
      file: relative(options.outDir, options.input),
      generatedAt: new Date().toISOString(),
      generator: '@frontline/map-build',
    },
  });
  for (const team of ['alpha', 'bravo'] as const) {
    if (!spawns.some((s) => s.team === team || s.team === undefined)) {
      warnings.push(`沒有 ${team} 隊的出生點（GAMEPLAY_SpawnPoints 內的 empty，自訂屬性 team = ${team}）`);
    }
  }
  const manifestPath = join(options.outDir, 'map-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(options.outDir, 'collision.json'), JSON.stringify(collision));

  const boxes = collision.colliders.filter((c) => c.kind === 'box').length;
  const trimeshes = collision.colliders.filter((c) => c.kind === 'trimesh');
  return {
    manifestPath,
    chunks: chunkReports,
    textures: [...textureFiles].map(([path, bytes]) => ({ path, bytes })),
    library,
    colliders: {
      boxes,
      trimeshes: trimeshes.length,
      triangles: trimeshes.reduce((sum, c) => sum + (c.kind === 'trimesh' ? c.indices.length / 3 : 0), 0),
      heightfields: collision.colliders.filter((c) => c.kind === 'heightfield').length,
    },
    spawns: spawns.length,
    objectives: objectives.length,
    warnings,
  };
}
