import { defineConfig, devices } from '@playwright/test';

/**
 * 瀏覽器端到端測試。先 `vite build`，再以 `vite preview` 提供正式版建置。
 * 沒有 GPU 的環境（CI、雲端容器）用 SwiftShader 軟體繪圖：FPS 會很低，
 * 所以這裡只驗證行為，不驗證效能。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    },
  },
  webServer: {
    command: 'bunx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
