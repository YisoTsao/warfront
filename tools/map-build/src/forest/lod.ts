/**
 * 為 Blender 匯出的資產產生 LOD：
 * - 實心網格（岩石、樹幹、原木）以 meshoptimizer 簡化；
 * - 葉片卡（透明貼圖的四邊形）簡化會破壞外形，改成依序保留一部分卡片。
 * 名稱遵循 map-build 慣例：X_LOD0、X_LOD1。
 */
import type { Document, Mesh, Primitive } from '@gltf-transform/core';
import { compactPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

export interface LodPlan {
  /** LOD0 的實心網格目標比例（1 = 不簡化） */
  lod0Solid: number;
  /** LOD1 的實心網格目標比例 */
  lod1Solid: number;
  /** LOD1 保留的葉片卡比例 */
  lod1Cards: number;
}

export const isCardMaterial = (prim: Primitive) => prim.getMaterial()?.getAlphaMode() !== 'OPAQUE';

function simplifiedIndices(prim: Primitive, ratio: number): Uint32Array | null {
  const indices = prim.getIndices();
  const position = prim.getAttribute('POSITION');
  if (!indices || !position || ratio >= 0.999) {
    return null;
  }
  const source = Uint32Array.from(indices.getArray()!);
  const positions = Float32Array.from(position.getArray()!);
  const target = Math.max(3, Math.floor((source.length / 3) * ratio) * 3);
  const [result] = MeshoptSimplifier.simplify(source, positions, 3, target, 0.05, []);
  if (result.length > target * 1.6) {
    // UV 接縫讓一般簡化卡住時，改用不保留拓撲的簡化
    const [sloppy] = MeshoptSimplifier.simplifySloppy(source, positions, 3, null, target, 0.08);
    return sloppy.length >= 3 ? sloppy : result;
  }
  return result;
}

/** 葉片卡：每個四邊形是相鄰兩個三角形，依固定間隔保留。 */
function thinnedCards(prim: Primitive, keep: number): Uint32Array | null {
  const indices = prim.getIndices()?.getArray();
  if (!indices || keep >= 0.999) {
    return null;
  }
  const out: number[] = [];
  const quads = Math.floor(indices.length / 6);
  let acc = 0;
  for (let q = 0; q < quads; q++) {
    acc += keep;
    if (acc >= 1) {
      acc -= 1;
      for (let k = 0; k < 6; k++) {
        out.push(indices[q * 6 + k]!);
      }
    }
  }
  return out.length >= 3 ? Uint32Array.from(out) : null;
}

/** 換上新的索引，並只保留用到的頂點（LOD 不再背著完整的頂點陣列）。 */
function withIndices(doc: Document, prim: Primitive, indices: Uint32Array | null): Primitive {
  const copy = prim.clone();
  if (indices) {
    copy.setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(doc.getRoot().listBuffers()[0]!));
    compactPrimitive(copy);
  }
  return copy;
}

/** 把 mesh 改名為 X_LOD0（依計畫簡化）並建立 X_LOD1。回傳 LOD0 網格。 */
export async function buildLods(doc: Document, mesh: Mesh, plan: LodPlan): Promise<Mesh> {
  await MeshoptSimplifier.ready;
  const base = mesh.getName();
  const lod1 = doc.createMesh(`${base}_LOD1`);
  for (const prim of mesh.listPrimitives()) {
    const card = isCardMaterial(prim);
    lod1.addPrimitive(withIndices(doc, prim, card ? thinnedCards(prim, plan.lod1Cards) : simplifiedIndices(prim, plan.lod1Solid)));
    if (!card && plan.lod0Solid < 0.999) {
      const reduced = simplifiedIndices(prim, plan.lod0Solid);
      if (reduced) {
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(reduced).setBuffer(doc.getRoot().listBuffers()[0]!));
        compactPrimitive(prim);
      }
    }
  }
  mesh.setName(`${base}_LOD0`);
  return mesh;
}

export function triangleCount(mesh: Mesh): number {
  return mesh.listPrimitives().reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? 0) / 3, 0);
}
