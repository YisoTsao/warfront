import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Document, Logger, NodeIO, type Mesh, type Node } from '@gltf-transform/core';
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
  log?: (message: string) => void;
}

export interface BuildReport {
  manifestPath: string;
  chunks: Array<{ id: string; bytes: number; nodes: number; instancedGroups: number }>;
  colliders: { boxes: number; trimeshes: number; triangles: number };
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
 */
function instanceAndLod(doc: Document, minCount: number, lodDistances: number[]): number {
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
  let instanced = 0;
  for (const [mesh, nodes] of groups) {
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

    if (nodes.length < minCount) {
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
        .setMesh(lodMesh)
        .setExtension('EXT_mesh_gpu_instancing', batch)
        .setExtras({ instance_count: nodes.length, ...lodExtras(level) });
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

export async function buildMap(options: BuildOptions): Promise<BuildReport> {
  const log = options.log ?? (() => undefined);
  const chunkSize = options.chunkSize ?? 64;
  const compress = options.compress ?? true;
  const lodDistances = options.lodDistances ?? [70, 160];
  const warnings: string[] = [];
  const io = createIO();
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  log(`讀取 ${options.input}`);
  const source = await io.read(options.input);
  const root = source.getRoot();
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
    const size = c.role === 'ENV_Terrain' ? Math.max(chunkSize, 128) : chunkSize;
    const ix = Math.floor((cx - mapBounds.min[0]) / size);
    const iz = Math.floor((cz - mapBounds.min[2]) / size);
    const id = `${c.role === 'ENV_Terrain' ? 'terrain' : 'detail'}-${ix}-${iz}`;
    const entry = chunkMembers.get(id) ?? { indices: [], bounds: emptyBox(), terrain: c.role === 'ENV_Terrain' };
    entry.indices.push(c.index);
    entry.bounds = unionBox(entry.bounds, b);
    chunkMembers.set(id, entry);
  }

  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(join(options.outDir, 'chunks'), { recursive: true });
  const chunks: MapChunk[] = [];
  const chunkReports: BuildReport['chunks'] = [];
  for (const [id, entry] of [...chunkMembers].sort(([a], [b]) => a.localeCompare(b))) {
    const doc = cloneDocument(source);
    doc.setLogger(new Logger(Logger.Verbosity.WARN));
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
    const instancedGroups = instanceAndLod(doc, options.instanceMin ?? 4, lodDistances);
    await doc.transform(prune({ keepLeaves: false }), dedup());
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
      ...(entry.terrain ? {} : { streamDistance: round(chunkSize * 2.5) }),
      byteLength: glb.byteLength,
    });
    chunkReports.push({ id, bytes: glb.byteLength, nodes: entry.indices.length, instancedGroups });
    log(`分塊 ${id}：${entry.indices.length} 個物件、${instancedGroups} 組 instancing、${(glb.byteLength / 1024).toFixed(0)} KB`);
  }

  // ---- manifest ----
  const minY = Math.min(mapBounds.min[1], ...collision.colliders.flatMap((c) => (c.kind === 'box' ? [c.center[1] - c.halfExtents[1]] : [])));
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
    colliders: {
      boxes,
      trimeshes: trimeshes.length,
      triangles: trimeshes.reduce((sum, c) => sum + (c.kind === 'trimesh' ? c.indices.length / 3 : 0), 0),
    },
    spawns: spawns.length,
    objectives: objectives.length,
    warnings,
  };
}
