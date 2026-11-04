import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** 伺服器設定（環境變數）。 */
export const config = {
  port: Number(process.env.PORT ?? 2567),
  host: process.env.HOST ?? '0.0.0.0',
  /** 地圖資料目錄（map-build 的輸出） */
  mapsDir: process.env.MAPS_DIR ?? resolve(REPO_ROOT, 'assets/maps'),
  defaultMap: process.env.DEFAULT_MAP ?? 'forest-valley',
  /** 每場預設以 bot 補到幾人（0 = 不放 bot）；客戶端可以在建立房間時要求 */
  defaultBotFill: Number(process.env.BOT_FILL ?? 8),
  resultsLog: process.env.RESULTS_LOG ?? resolve(REPO_ROOT, 'logs/match-results.jsonl'),
  /** 允許連線的網頁來源（逗號分隔）；未設定時允許任何來源（開發用） */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  reconnectSeconds: Number(process.env.RECONNECT_SECONDS ?? 30),
  /** 每個 IP 每 10 秒最多加入幾次（負載測試從同一台機器連線時需要調高） */
  joinRateLimit: Number(process.env.JOIN_RATE_LIMIT ?? 12),
  /** 測試用：縮短暖身與結算時間 */
  warmupSeconds: process.env.WARMUP_SECONDS ? Number(process.env.WARMUP_SECONDS) : undefined,
  resultSeconds: process.env.RESULT_SECONDS ? Number(process.env.RESULT_SECONDS) : undefined,
  /** 開發與自動化測試用指令（傳送等）。正式環境必須保持關閉。 */
  devCommands: process.env.DEV_COMMANDS === '1',
};

export function mapExists(mapId: string): boolean {
  return mapId === 'graybox' || existsSync(resolve(config.mapsDir, mapId, 'map-manifest.json'));
}
