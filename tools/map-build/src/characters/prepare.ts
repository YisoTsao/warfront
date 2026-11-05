/**
 * 準備角色資產（Quaternius 的 CC0 模型，從 Poly Pizza 下載）：
 *
 *   bun run --cwd tools/map-build characters -- --swat <SWAT.glb> --soldier-pack <Character Soldier.glb>
 *
 * - 士兵：SWAT（https://poly.pizza/m/Btfn3G5Xv4）原樣複製成 assets/characters/soldier/soldier.glb；
 * - 步槍：從 Character Soldier（https://poly.pizza/m/PpLF4rt4ah）取出掛在手上的 AK 網格，
 *   把頂點轉成「槍托在原點、槍口朝 −Z、上方 +Y、全長 RIFLE_LENGTH」，寫成 assets/characters/weapons/ak.glb。
 *   前端把步槍原點放在肩膀，不需要再猜模型的軸向與比例。
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Document, NodeIO, type Accessor, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune } from '@gltf-transform/functions';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const RIFLE_LENGTH = 0.9;

const { values } = parseArgs({
  options: {
    swat: { type: 'string' },
    'soldier-pack': { type: 'string' },
  },
});
if (!values.swat || !values['soldier-pack']) {
  console.error('用法：characters --swat <SWAT.glb> --soldier-pack <Character Soldier.glb>');
  process.exit(1);
}

const soldierOut = resolve(REPO_ROOT, 'assets/characters/soldier/soldier.glb');
mkdirSync(dirname(soldierOut), { recursive: true });
copyFileSync(resolve(values.swat), soldierOut);
console.log(`士兵：${soldierOut}`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const pack = await io.read(resolve(values['soldier-pack']));
const akNode = pack.getRoot().listNodes().find((n) => n.getMesh()?.getName() === 'AK');
if (!akNode) {
  throw new Error('Character Soldier 裡找不到 AK 網格');
}
const akMesh = akNode.getMesh()!;

// 模型座標：槍身沿 +X（槍托在 −X、槍口在 +X）、高度沿 +Z、厚度沿 Y。
// 轉成：+X → −Z（槍口）、+Z → +Y（上方）、Y → +X。
const remap = (x: number, y: number, z: number): [number, number, number] => [y, z, -x];

let minX = Infinity;
let maxX = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;
for (const p of akMesh.listPrimitives()) {
  const pos = p.getAttribute('POSITION')!;
  minX = Math.min(minX, pos.getMin([])[0]!);
  maxX = Math.max(maxX, pos.getMax([])[0]!);
  minZ = Math.min(minZ, pos.getMin([])[2]!);
  maxZ = Math.max(maxZ, pos.getMax([])[2]!);
}
const scale = RIFLE_LENGTH / (maxX - minX);
const midZ = (minZ + maxZ) / 2;

const out = new Document();
const buffer = out.createBuffer();
const mesh = out.createMesh('AK');
const copyAccessor = (a: Accessor, transform?: (v: number[]) => number[]): Accessor => {
  const array = a.getArray()!.slice();
  const size = a.getElementSize();
  if (transform) {
    for (let i = 0; i < a.getCount(); i++) {
      const v = transform(Array.from(array.subarray(i * size, i * size + size)));
      array.set(v, i * size);
    }
  }
  return out.createAccessor().setType(a.getType()).setArray(array).setBuffer(buffer);
};
for (const p of akMesh.listPrimitives() as Primitive[]) {
  const src = p.getMaterial();
  // 原本是卡通風格的亮灰色：金屬部分壓暗、木頭保留，比較接近寫實的步槍
  const [r, g, b, a] = src?.getBaseColorFactor() ?? [0.3, 0.3, 0.3, 1];
  const dim = /wood/i.test(src?.getName() ?? '') ? 0.7 : 0.3;
  const material = out
    .createMaterial(src?.getName() ?? 'AK')
    .setBaseColorFactor([r * dim, g * dim, b * dim, a])
    .setRoughnessFactor(src?.getRoughnessFactor() ?? 0.7)
    .setMetallicFactor(src?.getMetallicFactor() ?? 0);
  const prim = out
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', copyAccessor(p.getAttribute('POSITION')!, ([x, y, z]) => remap((x! - minX) * scale, y! * scale, (z! - midZ) * scale)))
    .setAttribute('NORMAL', copyAccessor(p.getAttribute('NORMAL')!, ([x, y, z]) => remap(x!, y!, z!)));
  const indices = p.getIndices();
  if (indices) {
    prim.setIndices(copyAccessor(indices));
  }
  mesh.addPrimitive(prim);
}
out.createScene('AK').addChild(out.createNode('AK').setMesh(mesh));
await out.transform(prune());
const akOut = resolve(REPO_ROOT, 'assets/characters/weapons/ak.glb');
mkdirSync(dirname(akOut), { recursive: true });
await io.write(akOut, out);
console.log(`步槍：${akOut}（全長 ${RIFLE_LENGTH} m，縮放 ${scale.toFixed(1)}）`);
