# FRONTLINE

在桌面瀏覽器直接遊玩的寫實現代軍事多人 FPS。開啟網址就能玩，不需要安裝。

- 規模：每場最多 16 人（8 對 8），人數不足時以 bot 補位
- 模式：團隊死鬥、征服
- 地圖：Blender 匯出的 GLB 經 `map-build` 轉換後載入（目前內建範例谷地與灰盒測試場；Blackwood Valley 原始檔到位後走同一條流程）
- 技術：TypeScript、Three.js（WebGL 2）、Rapier（WASM，前後端共用）、Vite + React；Colyseus 權威伺服器
- 主規格：[`docs/FRONTLINE_WEB_PROJECT_SPEC.md`](docs/FRONTLINE_WEB_PROJECT_SPEC.md)；進度：[`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md)

## 快速開始

需要 [Bun](https://bun.sh) 1.4 以上與 Node.js 22 LTS。

```bash
bun install
```

產生範例地圖（Blender 匯出格式的範例 GLB → 執行期地圖資料）：

```bash
bun run maps:sample
```

同時啟動網頁（http://localhost:5173）與對戰伺服器（ws://localhost:2567）：

```bash
bun run dev
```

主選單可以進入訓練場（單機靶場）或快速對戰。對戰伺服器預設以 8 人為目標補 bot，一個人也能玩。

## 操作

| 按鍵 | 動作 |
|---|---|
| W A S D | 移動 |
| 滑鼠 | 視角 |
| 左鍵 / 右鍵 | 開火 / 瞄準 |
| 左 Shift（按住） | 衝刺（只能往前） |
| 空白鍵 | 跳躍；蹲或臥時起身 |
| C / Z | 蹲下 / 臥倒 |
| R | 換彈 |
| 1、2、滾輪 | 切換武器 |
| B | 射擊模式 |
| G | 手榴彈 |
| Q | 兵種技能 |
| E（按住） | 救援倒地隊友 |
| X（按住） | 倒地時放棄 |
| Tab / M（按住） | 計分板 / 戰術地圖 |
| Esc | 暫停並釋放滑鼠 |

所有按鍵都可以在設定中重新綁定。蹲下預設不用 Ctrl：瀏覽器在一般 Pointer Lock 下攔不到 Ctrl+W。

## 指令

| 指令 | 用途 |
|---|---|
| `bun run dev` | 網頁 + 對戰伺服器（開發模式） |
| `bun run dev:web` / `bun run dev:server` | 只啟動其中一個 |
| `bun run check` | 型別檢查 + lint + 單元測試 |
| `bun run build` | 建置網頁到 `apps/web/dist` |
| `bun run build:server` | 把伺服器打包成單一 `apps/game-server/dist/index.js` |
| `bun run server` | 以 Node 執行伺服器（不監看檔案） |
| `bun run e2e` | 產生範例地圖、建置，並用 Playwright 在真實瀏覽器跑端到端測試（會自動啟動伺服器） |
| `bun run maps:sample` | 產生範例谷地 |
| `bun run maps:build -- --input <glb> --id <地圖 id> --name <名稱>` | 轉換 Blender 匯出的地圖 |
| `bun run load-test -- --clients 16 --seconds 60` | 對執行中的伺服器做 16 人負載測試 |

第一次跑 e2e 前，需要安裝 Playwright 的 Chromium：

```bash
bunx playwright install chromium
```

網址參數 `?debug=1` 會開啟除錯介面（`window.__frontline`），e2e 測試用它讀取遊戲狀態。

## 目錄結構

```
apps/
  web/                 瀏覽器用戶端（Vite + React + Three.js）
  game-server/         Colyseus 權威伺服器、bot、指標、負載測試、Dockerfile
packages/
  shared/              前後端共用：移動規則、數學、亂數、網路協定
  simulation/          前後端共用：Rapier 世界、角色控制器、hitbox、彈道、武器狀態機
  game-config/         武器、配件、手榴彈、兵種、模式資料
  map-schema/          地圖 manifest 與碰撞資料 schema、Blender 命名慣例、灰盒地圖
tools/
  map-build/           Blender GLB → 執行期地圖（分塊、instancing、LOD、碰撞、遊戲標記）
assets/
  blender-source/      Blender 原始檔與匯出的 GLB
  maps/                map-build 的輸出（瀏覽器與伺服器都讀這裡）
docs/                  規格與設計文件
legacy/ue5/            舊版 UE5 C++ 骨架（只供參考，保留到 2026-11-10 後刪除）
```

## 文件

| 文件 | 內容 |
|---|---|
| [`FRONTLINE_WEB_PROJECT_SPEC.md`](docs/FRONTLINE_WEB_PROJECT_SPEC.md) | 主規格（以此為準） |
| [`DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) | 各階段狀態、驗收結果、已知限制、待確認事項 |
| [`TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) | 模組、資料流、程式規則 |
| [`NETWORKING_SPEC.md`](docs/NETWORKING_SPEC.md) | 權威伺服器、預測與修正、命中驗證、重連 |
| [`ASSET_PIPELINE.md`](docs/ASSET_PIPELINE.md) | Blender → GLB → map-build 流程與命名慣例 |
| [`ART_DIRECTION.md`](docs/ART_DIRECTION.md) | 美術方向與畫質策略 |
| [`DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 靜態網站與對戰伺服器部署 |
| [`SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) | 權威規則與防作弊檢查 |
| [`PERFORMANCE.md`](docs/PERFORMANCE.md) | 效能量測方法與結果 |
| [`PHASE0_ENVIRONMENT_REPORT.md`](docs/PHASE0_ENVIRONMENT_REPORT.md) | 環境與資產盤點 |
