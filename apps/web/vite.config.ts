import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    // Rapier 的 WASM 以 base64 內嵌，單一 chunk 會超過預設警告門檻。
    chunkSizeWarningLimit: 5500,
  },
});
