/**
 * 匯入 blender-mcp-asset-generator 產生的森林谷地：
 *
 *   bun run maps:forest -- --source ../blender-mcp-asset-generator/output
 *
 * 1. 把 phase1–5 的輸出組成符合匯入慣例的 GLB（assets/blender-source/exports/forest-valley.glb）
 * 2. 以 map-build 產生前端與伺服器使用的地圖資料（assets/maps/forest-valley/）
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildMap } from '../build';
import { importForestValley } from './importForestValley';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    glb: { type: 'string' },
    out: { type: 'string' },
    id: { type: 'string', default: 'forest-valley' },
    name: { type: 'string', default: '森林谷地' },
    'skip-build': { type: 'boolean', default: false },
  },
});

if (!values.source) {
  console.error('用法：maps:forest --source <blender-mcp-asset-generator/output> [--glb 輸出 GLB] [--out 地圖目錄] [--id forest-valley] [--name 名稱] [--skip-build]');
  process.exit(1);
}

const started = performance.now();
const glb = resolve(values.glb ?? resolve(REPO_ROOT, `assets/blender-source/exports/${values.id}.glb`));
const report = await importForestValley({ source: resolve(values.source), output: glb, log: (m) => console.log(m) });
console.log('\n實例（保留／清除）：');
for (const [name, r] of Object.entries(report.instances)) {
  console.log(`  ${name.padEnd(16)} ${String(r.kept).padStart(6)} / ${r.removed}`);
}
console.log(`碰撞物 ${report.colliders}、出生點 ${report.spawns}、據點 ${report.objectives}、水域 ${report.waterVolumes}`);
for (const w of report.warnings) console.warn(`警告：${w}`);

if (!values['skip-build']) {
  const outDir = resolve(values.out ?? resolve(REPO_ROOT, 'assets/maps', values.id!));
  const built = await buildMap({ input: glb, outDir, id: values.id!, name: values.name!, log: (m) => console.log(m) });
  const chunkBytes = built.chunks.reduce((s, c) => s + c.bytes, 0);
  const textureBytes = built.textures.reduce((s, t) => s + t.bytes, 0);
  console.log(`\n完成：${built.manifestPath}`);
  console.log(`分塊 ${built.chunks.length} 個 ${(chunkBytes / 1024 / 1024).toFixed(2)} MB、共用貼圖 ${built.textures.length} 張 ${(textureBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`碰撞：${built.colliders.boxes} 個方塊、${built.colliders.heightfields} 個高度場`);
  for (const w of built.warnings) console.warn(`警告：${w}`);
}
console.log(`耗時 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
