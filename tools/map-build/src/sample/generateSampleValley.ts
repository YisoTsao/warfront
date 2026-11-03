/**
 * 產生「範例谷地」：一個依 Blender 匯出慣例組成的 GLB，用來驗證 map-build 與前端載入流程。
 * 真正的 Blackwood Valley 由美術在 Blender 匯出後，走同一條 map-build 流程。
 *
 * 結構：頂層節點以集合名稱命名（ENV_*、COLLISION_*、GAMEPLAY_*、LIGHTING_Reference），
 * 遊戲標記用 empty 加自訂屬性（glTF extras），LOD 以 _LOD0 / _LOD1 命名。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Document, NodeIO, type Material, type Mesh, type Node } from '@gltf-transform/core';
import { box, cone, emptyMesh, merge, rock, type MeshData } from './geometry';
import { FLAT_AREAS, HALF_SIZE, PLAYABLE_HALF, riverX, terrainColor, terrainHeight, terrainSlope } from './terrain';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
export const SAMPLE_SOURCE_PATH = resolve(REPO_ROOT, 'assets/blender-source/exports/sample-valley.glb');

let seed = 20261103;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

type Quat = [number, number, number, number];
const yawQuat = (yaw: number): Quat => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

export async function generateSampleValley(outputPath = SAMPLE_SOURCE_PATH): Promise<string> {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);

  const collections = new Map<string, Node>();
  const collection = (name: string): Node => {
    let node = collections.get(name);
    if (!node) {
      node = doc.createNode(name);
      scene.addChild(node);
      collections.set(name, node);
    }
    return node;
  };

  const material = (name: string, color: [number, number, number], roughness = 0.9, opts: { vertexColors?: boolean; alpha?: number } = {}): Material => {
    const m = doc.createMaterial(name).setBaseColorFactor([...color, opts.alpha ?? 1]).setRoughnessFactor(roughness).setMetallicFactor(0);
    if (opts.alpha !== undefined && opts.alpha < 1) {
      m.setAlphaMode('BLEND');
    }
    return m;
  };

  const meshFrom = (name: string, parts: Array<{ data: MeshData; material: Material }>): Mesh => {
    const mesh = doc.createMesh(name);
    for (const part of parts) {
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(part.data.positions)))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(part.data.normals)))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(part.data.indices)))
        .setMaterial(part.material);
      if (part.data.colors) {
        prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(new Float32Array(part.data.colors)));
      }
      mesh.addPrimitive(prim);
    }
    return mesh;
  };

  const place = (parent: Node, name: string, mesh: Mesh | null, t: [number, number, number], r: Quat = [0, 0, 0, 1], s: [number, number, number] = [1, 1, 1], extras?: Record<string, unknown>): Node => {
    const node = doc.createNode(name).setTranslation(t).setRotation(r).setScale(s);
    if (mesh) {
      node.setMesh(mesh);
    }
    if (extras) {
      node.setExtras(extras);
    }
    parent.addChild(node);
    return node;
  };

  // ---- 材質 ----
  const terrainMat = material('Terrain', [1, 1, 1], 0.97, { vertexColors: true });
  const waterMat = material('Water', [0.16, 0.28, 0.32], 0.08, { alpha: 0.78 });
  const barkMat = material('Bark', [0.24, 0.17, 0.11]);
  const needleMat = material('PineNeedles', [0.12, 0.24, 0.12], 0.85);
  const bushMat = material('Bush', [0.18, 0.3, 0.13], 0.9);
  const rockMat = material('Rock', [0.42, 0.41, 0.39], 0.95);
  const plasterMat = material('Plaster', [0.62, 0.58, 0.5]);
  const roofMat = material('RoofTiles', [0.36, 0.2, 0.15]);
  const woodMat = material('Wood', [0.38, 0.28, 0.18]);
  const stoneMat = material('BridgeStone', [0.5, 0.49, 0.46]);
  const sandbagMat = material('Sandbag', [0.55, 0.48, 0.34]);
  const metalMat = material('Metal', [0.3, 0.32, 0.3], 0.5);
  const fenceMat = material('ChainLink', [0.5, 0.52, 0.5], 0.6, { alpha: 0.45 });
  const crateMat = material('Crate', [0.45, 0.36, 0.2]);

  // 碰撞用單位方塊（Blender 中縮放過的 Cube）
  const unitCube = meshFrom('CollisionCube', [{ data: box(2, 2, 2), material: metalMat }]);
  const collisionStatic = collection('COLLISION_Static');
  const collisionBox = (name: string, center: [number, number, number], half: [number, number, number], yaw = 0, extras: Record<string, unknown> = {}) =>
    place(collisionStatic, name, unitCube, center, yawQuat(yaw), half, { collider: 'box', ...extras });

  // ---- 地形（四塊 128 m 分塊）與地形碰撞 ----
  const tileSize = HALF_SIZE;
  const segments = 64;
  for (let tx = 0; tx < 2; tx++) {
    for (let tz = 0; tz < 2; tz++) {
      const x0 = -HALF_SIZE + tx * tileSize;
      const z0 = -HALF_SIZE + tz * tileSize;
      const cx = x0 + tileSize / 2;
      const cz = z0 + tileSize / 2;
      const data: MeshData = { positions: [], normals: [], indices: [], colors: [] };
      for (let j = 0; j <= segments; j++) {
        for (let i = 0; i <= segments; i++) {
          const x = x0 + (i / segments) * tileSize;
          const z = z0 + (j / segments) * tileSize;
          const y = terrainHeight(x, z);
          const e = 0.5;
          const nx = terrainHeight(x - e, z) - terrainHeight(x + e, z);
          const nz = terrainHeight(x, z - e) - terrainHeight(x, z + e);
          const nl = Math.hypot(nx, 2 * e, nz);
          data.positions.push(x - cx, y, z - cz);
          data.normals.push(nx / nl, (2 * e) / nl, nz / nl);
          data.colors!.push(...terrainColor(x, z, y));
        }
      }
      for (let j = 0; j < segments; j++) {
        for (let i = 0; i < segments; i++) {
          const a = j * (segments + 1) + i;
          const b = a + 1;
          const c = a + segments + 1;
          const d = c + 1;
          data.indices.push(a, c, b, b, c, d);
        }
      }
      const visual = meshFrom(`Terrain_${tx}_${tz}`, [{ data, material: terrainMat }]);
      place(collection('ENV_Terrain'), `Terrain_${tx}_${tz}`, visual, [cx, 0, cz]);
      const collisionData: MeshData = { positions: data.positions, normals: data.normals, indices: data.indices };
      const collisionMesh = meshFrom(`Terrain_${tx}_${tz}_Collision`, [{ data: collisionData, material: metalMat }]);
      place(collisionStatic, `Terrain_${tx}_${tz}_Col`, collisionMesh, [cx, 0, cz], [0, 0, 0, 1], [1, 1, 1], { material: 'dirt' });
    }
  }

  // ---- 河流水面與水域 ----
  const waterLevel = -2.2;
  const water: MeshData = emptyMesh();
  const waterSegments = 64;
  for (let j = 0; j <= waterSegments; j++) {
    const z = -PLAYABLE_HALF + (j / waterSegments) * PLAYABLE_HALF * 2;
    const rx = riverX(z);
    water.positions.push(rx - 16, waterLevel, z, rx + 16, waterLevel, z);
    water.normals.push(0, 1, 0, 0, 1, 0);
  }
  for (let j = 0; j < waterSegments; j++) {
    const a = j * 2;
    water.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  place(collection('ENV_Terrain'), 'Water_River', meshFrom('Water_River', [{ data: water, material: waterMat }]), [0, 0, 0]);
  const waterVolumes = collection('GAMEPLAY_WaterVolumes');
  for (let z = -PLAYABLE_HALF + 16; z < PLAYABLE_HALF; z += 32) {
    place(waterVolumes, `River_Deep_${Math.round(z)}`, null, [riverX(z), waterLevel - 1.5, z], [0, 0, 0, 1], [4, 1.5, 16], { depth: 'deep' });
    place(waterVolumes, `River_Shallow_${Math.round(z)}`, null, [riverX(z), waterLevel - 0.6, z], [0, 0, 0, 1], [9, 0.7, 16], { depth: 'shallow' });
  }

  // ---- 石橋（B 據點） ----
  const bridgeHalf = 19;
  const bridgeY = Math.max(terrainHeight(-bridgeHalf, 0), terrainHeight(bridgeHalf, 0)) + 0.25;
  const bridge = emptyMesh();
  merge(bridge, box(bridgeHalf * 2, 0.5, 4.4), [0, -0.25, 0]);
  merge(bridge, box(bridgeHalf * 2, 1, 0.3), [0, 0.5, 2.05]);
  merge(bridge, box(bridgeHalf * 2, 1, 0.3), [0, 0.5, -2.05]);
  for (const px of [-8, 0, 8]) {
    merge(bridge, box(1.4, Math.max(1, bridgeY - waterLevel + 2), 3.6), [px, -0.5 - (bridgeY - waterLevel + 2) / 2, 0]);
  }
  place(collection('ENV_Buildings'), 'Bridge', meshFrom('Bridge', [{ data: bridge, material: stoneMat }]), [riverX(0), bridgeY, 0]);
  collisionBox('Bridge_Deck_Col', [riverX(0), bridgeY - 0.25, 0], [bridgeHalf, 0.25, 2.2], 0, { material: 'stone' });
  collisionBox('Bridge_Rail_N_Col', [riverX(0), bridgeY + 0.5, -2.05], [bridgeHalf, 0.5, 0.15], 0, { material: 'stone' });
  collisionBox('Bridge_Rail_S_Col', [riverX(0), bridgeY + 0.5, 2.05], [bridgeHalf, 0.5, 0.15], 0, { material: 'stone' });

  // ---- 村落（C 據點）：三棟可以進入的房子 ----
  const village: Array<[number, number, number]> = [
    [52, 38, 0],
    [68, 40, Math.PI / 2],
    [58, 56, Math.PI],
  ];
  village.forEach(([hx, hz, yaw], index) => {
    const ground = terrainHeight(hx, hz);
    const w = 8;
    const d = 6;
    const h = 3.2;
    const t = 0.3;
    const door = 1.4;
    const walls: Array<{ size: [number, number, number]; offset: [number, number, number] }> = [
      { size: [w, h, t], offset: [0, h / 2, -d / 2 + t / 2] },
      { size: [t, h, d], offset: [-w / 2 + t / 2, h / 2, 0] },
      { size: [t, h, d], offset: [w / 2 - t / 2, h / 2, 0] },
      { size: [(w - door) / 2, h, t], offset: [-(w + door) / 4, h / 2, d / 2 - t / 2] },
      { size: [(w - door) / 2, h, t], offset: [(w + door) / 4, h / 2, d / 2 - t / 2] },
      { size: [door, h - 2.3, t], offset: [0, 2.3 + (h - 2.3) / 2, d / 2 - t / 2] },
    ];
    const house = emptyMesh();
    for (const wall of walls) {
      merge(house, box(...wall.size), wall.offset);
    }
    const roof = box(w + 0.8, 0.3, d + 0.8);
    const name = `House_${index + 1}`;
    place(collection('ENV_Buildings'), name, meshFrom(name, [{ data: house, material: plasterMat }, { data: merge(emptyMesh(), roof, [0, h + 0.15, 0]), material: roofMat }]), [hx, ground, hz], yawQuat(yaw));
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const rotate = ([ox, oy, oz]: [number, number, number]): [number, number, number] => [hx + ox * cos + oz * sin, ground + oy, hz - ox * sin + oz * cos];
    walls.forEach((wall, i) =>
      collisionBox(`${name}_Wall_${i}_Col`, rotate(wall.offset), [wall.size[0] / 2, wall.size[1] / 2, wall.size[2] / 2], yaw, { material: 'plaster' }),
    );
    collisionBox(`${name}_Roof_Col`, rotate([0, h + 0.15, 0]), [(w + 0.8) / 2, 0.15, (d + 0.8) / 2], yaw, { material: 'wood' });
    // 室內道具
    const crate = rotate([-2.5, 0.5, -1.5]);
    place(collection('ENV_Props'), `${name}_Crate`, meshFrom(`${name}_CrateMesh`, [{ data: box(1, 1, 1), material: crateMat }]), crate, yawQuat(yaw));
    collisionBox(`${name}_Crate_Col`, crate, [0.5, 0.5, 0.5], yaw, { material: 'wood' });
    const table = rotate([2, 0.4, -1]);
    place(collection('ENV_Props'), `${name}_Table`, meshFrom(`${name}_TableMesh`, [{ data: box(1.6, 0.8, 0.9), material: woodMat }]), table, yawQuat(yaw));
    collisionBox(`${name}_Table_Col`, table, [0.8, 0.4, 0.45], yaw, { material: 'wood' });
  });
  // 鐵絲網：擋人不擋子彈（layer = movement）
  const fenceY = terrainHeight(60, 30);
  place(collection('ENV_Props'), 'Fence_ChainLink', meshFrom('Fence_ChainLink', [{ data: box(14, 2, 0.05), material: fenceMat }]), [60, fenceY + 1, 30]);
  collisionBox('Fence_ChainLink_Col', [60, fenceY + 1, 30], [7, 1, 0.1], 0, { layer: 'movement', material: 'metal' });

  // ---- 北哨站（A 據點）：沙包與瞭望塔 ----
  const [ax, az] = [-55, -60];
  const aGround = terrainHeight(ax, az);
  const sandbags: Array<[number, number, number, number]> = [
    [ax - 6, az, 0.3, Math.PI / 2],
    [ax + 6, az, 0.3, Math.PI / 2],
    [ax, az - 6, 0.3, 0],
    [ax + 3, az + 6, 0.3, 0],
    [riverX(0) - 22, 2, 0.3, Math.PI / 2],
    [riverX(0) + 22, -2, 0.3, Math.PI / 2],
  ];
  sandbags.forEach(([sx, sz, , yaw], i) => {
    const y = terrainHeight(sx, sz);
    place(collection('ENV_Props'), `Sandbags_${i}`, meshFrom(`Sandbags_${i}`, [{ data: box(4, 1.1, 0.8), material: sandbagMat }]), [sx, y + 0.55, sz], yawQuat(yaw));
    collisionBox(`Sandbags_${i}_Col`, [sx, y + 0.55, sz], [2, 0.55, 0.4], yaw, { material: 'sand' });
  });
  const tower = emptyMesh();
  for (const [lx, lz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]] as const) {
    merge(tower, box(0.25, 5, 0.25), [lx, 2.5, lz]);
  }
  merge(tower, box(3.2, 0.25, 3.2), [0, 5, 0]);
  merge(tower, box(3.6, 0.2, 3.6), [0, 7, 0]);
  place(collection('ENV_Buildings'), 'Watchtower', meshFrom('Watchtower', [{ data: tower, material: woodMat }]), [ax + 2, aGround, az - 2]);
  for (const [lx, lz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]] as const) {
    collisionBox(`Watchtower_Leg_${lx}_${lz}_Col`, [ax + 2 + lx, aGround + 2.5, az - 2 + lz], [0.125, 2.5, 0.125], 0, { material: 'wood' });
  }
  collisionBox('Watchtower_Platform_Col', [ax + 2, aGround + 5, az - 2], [1.6, 0.125, 1.6], 0, { material: 'wood' });

  // ---- 樹木（LOD0 / LOD1）與樹幹碰撞 ----
  const pineLod0 = emptyMesh();
  merge(pineLod0, cone(1.9, 0.2, 3.2, 10, 2));
  merge(pineLod0, cone(1.5, 0.15, 2.8, 10, 3.8));
  merge(pineLod0, cone(1.0, 0.05, 2.5, 10, 5.4));
  const trunk = cone(0.2, 0.14, 3, 8);
  const pineMesh0 = meshFrom('Pine_LOD0', [{ data: trunk, material: barkMat }, { data: pineLod0, material: needleMat }]);
  const pineMesh1 = meshFrom('Pine_LOD1', [{ data: cone(0.2, 0.15, 2, 5), material: barkMat }, { data: cone(1.7, 0.1, 6.2, 6, 1.6), material: needleMat }]);
  const trees = collection('ENV_Trees');
  // LOD 資料庫物件：不擺在場景裡，只提供網格
  place(trees, 'Pine_LOD1', pineMesh1, [0, -500, 0], [0, 0, 0, 1], [1, 1, 1], { lod_library: true });
  const occupied: Array<[number, number, number]> = [...FLAT_AREAS.map(([x, z, r]) => [x, z, r + 2] as [number, number, number]), [riverX(0), 0, 24]];
  const free = (x: number, z: number, margin: number) =>
    occupied.every(([ox, oz, r]) => Math.hypot(x - ox, z - oz) > r + margin) && Math.abs(x - riverX(z)) > 13;
  let treeCount = 0;
  for (let attempt = 0; attempt < 5000 && treeCount < 480; attempt++) {
    const x = (random() * 2 - 1) * (PLAYABLE_HALF + 8);
    const z = (random() * 2 - 1) * (PLAYABLE_HALF + 8);
    if (!free(x, z, 3) || terrainSlope(x, z) > 0.6) {
      continue;
    }
    const scale = 0.8 + random() * 0.55;
    const y = terrainHeight(x, z) - 0.1;
    treeCount++;
    place(trees, `Pine.${String(treeCount).padStart(3, '0')}`, pineMesh0, [x, y, z], yawQuat(random() * Math.PI * 2), [scale, scale, scale]);
    collisionBox(`Pine.${String(treeCount).padStart(3, '0')}_Trunk_Col`, [x, y + 1.6 * scale, z], [0.2 * scale, 1.6 * scale, 0.2 * scale], 0, { material: 'wood' });
    occupied.push([x, z, 1.5]);
  }

  // ---- 灌木（只有視覺） ----
  const bushMesh = meshFrom('Bush', [{ data: merge(emptyMesh(), cone(0.9, 0.3, 1.1, 7)), material: bushMat }]);
  for (let i = 0, placed = 0; i < 3000 && placed < 260; i++) {
    const x = (random() * 2 - 1) * PLAYABLE_HALF;
    const z = (random() * 2 - 1) * PLAYABLE_HALF;
    if (!free(x, z, 1) || terrainSlope(x, z) > 0.5) {
      continue;
    }
    placed++;
    const s = 0.6 + random() * 0.8;
    place(collection('ENV_Foliage'), `Bush.${placed}`, bushMesh, [x, terrainHeight(x, z) - 0.05, z], yawQuat(random() * 6.28), [s, s, s]);
  }

  // ---- 岩石 ----
  const rockMeshes = [1, 2, 3].map((v) => meshFrom(`Rock_${v}`, [{ data: rock(1, v * 977), material: rockMat }]));
  for (let i = 0, placed = 0; i < 3000 && placed < 70; i++) {
    const x = (random() * 2 - 1) * (PLAYABLE_HALF + 10);
    const z = (random() * 2 - 1) * (PLAYABLE_HALF + 10);
    if (!free(x, z, 2)) {
      continue;
    }
    placed++;
    const s = 0.7 + random() * 1.8;
    const y = terrainHeight(x, z);
    place(collection('ENV_Rocks'), `Rock.${placed}`, rockMeshes[placed % 3]!, [x, y, z], yawQuat(random() * 6.28), [s, s, s]);
    if (s > 1.1) {
      collisionBox(`Rock.${placed}_Col`, [x, y + 0.2 * s, z], [0.85 * s, 0.6 * s, 0.85 * s], 0, { material: 'rock' });
    }
    occupied.push([x, z, s + 1]);
  }

  // ---- 出生點 ----
  const spawns = collection('GAMEPLAY_SpawnPoints');
  for (const [team, z, yaw] of [['alpha', 88, 0], ['bravo', -88, Math.PI]] as const) {
    for (let i = 0; i < 8; i++) {
      const x = -14 + i * 4;
      place(spawns, `Spawn_${team}_${i + 1}`, null, [x, terrainHeight(x, z), z], yawQuat(yaw), [1, 1, 1], { team });
    }
  }

  // ---- 據點 ----
  const objectives = collection('GAMEPLAY_Objectives');
  place(objectives, 'Objective_A', null, [ax, aGround, az], [0, 0, 0, 1], [12, 12, 12], { objective_id: 'A', display_name: '北哨站' });
  place(objectives, 'Objective_B', null, [riverX(0), bridgeY, 0], [0, 0, 0, 1], [12, 12, 12], { objective_id: 'B', display_name: '石橋' });
  place(objectives, 'Objective_C', null, [60, terrainHeight(60, 45), 45], [0, 0, 0, 1], [16, 16, 16], { objective_id: 'C', display_name: '村落' });

  // ---- 禁區：對方出生區 ----
  const restricted = collection('GAMEPLAY_RestrictedAreas');
  place(restricted, 'Base_Alpha', null, [0, 0, 92], [0, 0, 0, 1], [24, 40, 14], { team: 'bravo', grace_seconds: 5 });
  place(restricted, 'Base_Bravo', null, [0, 0, -92], [0, 0, 0, 1], [24, 40, 14], { team: 'alpha', grace_seconds: 5 });

  // ---- 光照參考 ----
  // 太陽 empty 的 -Z 軸為光線方向（與 Blender 匯出後的燈光相同）
  const sunDir = [-0.45, -0.75, -0.48];
  const yaw = Math.atan2(-sunDir[0]!, -sunDir[2]!);
  const pitch = Math.asin(sunDir[1]!);
  const q: Quat = [
    Math.cos(yaw / 2) * Math.sin(pitch / 2),
    Math.sin(yaw / 2) * Math.cos(pitch / 2),
    -Math.sin(yaw / 2) * Math.sin(pitch / 2),
    Math.cos(yaw / 2) * Math.cos(pitch / 2),
  ];
  place(collection('LIGHTING_Reference'), 'Sun', null, [0, 80, 0], q, [1, 1, 1], {
    sun_color: '#ffe9cc',
    sun_intensity: 2.6,
    sky_color: '#a9bccb',
    fog_color: '#b4c3cc',
    fog_near: 50,
    fog_far: 260,
    hemisphere_sky: '#d6e2ec',
    hemisphere_ground: '#4b4a36',
    hemisphere_intensity: 1.0,
  });

  const glb = await new NodeIO().writeBinary(doc);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, glb);
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const path = await generateSampleValley(process.argv[2] ? resolve(process.argv[2]) : SAMPLE_SOURCE_PATH);
  console.log(`範例 Blender 匯出檔已產生：${path}`);
}
