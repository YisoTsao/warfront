/**
 * 把 Blender 匯出的 GLB 轉成瀏覽器與伺服器使用的地圖資料。
 *
 *   bun run maps:build -- --input assets/blender-source/exports/blackwood-valley.glb --id blackwood-valley --name "Blackwood Valley"
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildMap } from './build';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    out: { type: 'string' },
    'chunk-size': { type: 'string' },
    'no-compress': { type: 'boolean', default: false },
  },
});

if (!values.input || !values.id) {
  console.error('用法：map-build --input <匯出的 .glb> --id <地圖 id> [--name 顯示名稱] [--out 輸出目錄] [--chunk-size 64] [--no-compress]');
  process.exit(1);
}

const outDir = resolve(values.out ?? resolve(REPO_ROOT, 'assets/maps', values.id));
const report = await buildMap({
  input: resolve(values.input),
  outDir,
  id: values.id,
  name: values.name ?? values.id,
  chunkSize: values['chunk-size'] ? Number(values['chunk-size']) : 64,
  compress: !values['no-compress'],
  log: (m) => console.log(m),
});

const totalBytes = report.chunks.reduce((sum, c) => sum + c.bytes, 0);
console.log(`\n完成：${report.manifestPath}`);
console.log(`分塊 ${report.chunks.length} 個，共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`碰撞：${report.colliders.boxes} 個方塊、${report.colliders.trimeshes} 個三角網格（${report.colliders.triangles} 個三角形）`);
console.log(`出生點 ${report.spawns} 個、據點 ${report.objectives} 個`);
for (const warning of report.warnings) {
  console.warn(`警告：${warning}`);
}
