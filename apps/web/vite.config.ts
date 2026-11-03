import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const MAPS_DIR = resolve(REPO_ROOT, 'assets/maps');
const BASIS_DIR = resolve(import.meta.dirname, 'node_modules/three/examples/jsm/libs/basis');

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};

/**
 * 把 repo 的 assets/maps 以 /maps/ 提供（開發時直接讀檔，建置時複製到 dist），
 * 並提供 KTX2 轉碼器（/basis/）。地圖資料不放進 public，避免與原始資產重複一份。
 */
function frontlineAssets(): Plugin {
  const mounts: Array<{ prefix: string; dir: string }> = [
    { prefix: '/maps/', dir: MAPS_DIR },
    { prefix: '/basis/', dir: BASIS_DIR },
  ];
  const walk = (dir: string, base = ''): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((name) => {
          const full = join(dir, name);
          const rel = base ? `${base}/${name}` : name;
          return statSync(full).isDirectory() ? walk(full, rel) : [rel];
        })
      : [];
  const serve: NonNullable<Plugin['configureServer']> = (server) => {
    server.middlewares.use((req, res, next) => {
      const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
      const mount = mounts.find((m) => url.startsWith(m.prefix));
      if (!mount) {
        return next();
      }
      const file = resolve(mount.dir, `.${url.slice(mount.prefix.length - 1)}`);
      if (!file.startsWith(mount.dir) || !existsSync(file) || statSync(file).isDirectory()) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      createReadStream(file).pipe(res);
    });
  };
  return {
    name: 'frontline-assets',
    configureServer: serve,
    configurePreviewServer: serve as unknown as NonNullable<Plugin['configurePreviewServer']>,
    generateBundle() {
      for (const mount of mounts) {
        for (const rel of walk(mount.dir)) {
          if (mount.prefix === '/basis/' && !/^basis_transcoder\.(js|wasm)$/.test(rel)) {
            continue;
          }
          this.emitFile({ type: 'asset', fileName: `${mount.prefix.slice(1)}${rel}`, source: readFileSync(join(mount.dir, rel)) });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), frontlineAssets()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    // Rapier 的 WASM 以 base64 內嵌，單一 chunk 會超過預設警告門檻。
    chunkSizeWarningLimit: 5500,
  },
});
