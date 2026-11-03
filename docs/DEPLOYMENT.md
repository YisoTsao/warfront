# 部署

> 部署平台尚未決定。以下為與平台無關的做法：網站是靜態檔案，對戰伺服器是常駐容器。

## 1. 架構

```text
玩家瀏覽器 ──HTTPS──▶ 靜態網站（CDN：Vercel、Cloudflare Pages…）
            ──WSS───▶ 對戰伺服器（常駐容器，不能是 serverless function）
```

## 2. 靜態網站

```bash
VITE_GAME_SERVER_URL=wss://game.example.com bun run build
```

- 輸出：`apps/web/dist`（含 `/maps/` 地圖資料與 `/basis/` 轉碼器）。
- 平台設定：建置指令 `bun install && bun run maps:sample && bun run build`（正式地圖改成實際的 map-build 指令）、輸出目錄 `apps/web/dist`、單頁應用不需要額外路由。
- 快取：`/assets/*` 檔名含雜湊，可以長期快取；`/maps/*` 每次換地圖版本時要讓快取失效（或在 id 中加版本）。
- `.glb` 的 Content-Type：`model/gltf-binary`；`.wasm`：`application/wasm`。

## 3. 對戰伺服器

### 3.1 容器

```bash
docker build -f apps/game-server/Dockerfile -t frontline-server .
```

```bash
docker run -p 2567:2567 -e ALLOWED_ORIGINS=https://frontline.example.com frontline-server
```

- 映像只包含打包後的 `index.js`（約 6 MB，含 Rapier WASM）與地圖資料。
- 健康檢查：`GET /health`。
- 指標：`GET /metrics`（JSON）、`GET /metrics?format=prometheus`。
- 房間列表：`GET /rooms`。
- 收到 SIGTERM 時 Colyseus 會優雅關閉。

### 3.2 環境變數

見 `apps/game-server/.env.example`。正式環境必須：

- 設定 `ALLOWED_ORIGINS` 為網站網址。
- `DEV_COMMANDS` 保持關閉（0 或不設定）。
- 在前面放 TLS 終結（反向代理或平台提供），讓瀏覽器用 `wss://` 連線。

### 3.3 擴充

- 一個程序可以承載多個房間（16 人房的 tick 平均約 1.4 ms，見 `PERFORMANCE.md`）。
- 多個程序或多台機器時，需要 Colyseus 的 Redis presence 與 driver（`@colyseus/redis-presence`、`@colyseus/redis-driver`），並讓配對請求能找到房間所在的程序。目前尚未設定。

## 4. CI

`.github/workflows/ci.yml`：

1. `check`：安裝、型別檢查、lint、單元測試、建置網頁與伺服器。
2. `e2e`：安裝 Playwright Chromium、產生範例地圖、建置、執行全部 e2e（會自動啟動伺服器）。失敗時上傳測試結果。

## 5. 監控與告警（範例）

以 Prometheus 抓取 `/metrics?format=prometheus`，建議告警：

| 條件 | 意義 |
|---|---|
| `frontline_room_tick_ms_p95 > 25` 持續 5 分鐘 | 房間 tick 接近 33 ms 預算 |
| `rate(frontline_room_errors_total[5m]) > 0` | 房間發生未處理例外 |
| `rate(frontline_client_errors_total[5m]) > 1` | 瀏覽器端錯誤增加 |
| `frontline_rss_megabytes > 1500` | 記憶體異常 |
| `/health` 失敗 | 程序停止回應 |

## 6. 尚未驗證

本環境沒有 Docker，Dockerfile 尚未實際建置；但打包後的 `index.js` 已在空目錄以 Node 22 獨立執行、載入 GLB 地圖並通過 8 人負載測試。CI workflow 也尚未在 GitHub 上執行過。
