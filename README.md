# FRONTLINE

在桌面瀏覽器直接遊玩的寫實現代軍事多人 FPS。開啟網址就能玩，不需要安裝。

- 首張地圖：Blackwood Valley（Blender 製作）
- 規模：每場 16 人（8 對 8）
- 技術：TypeScript、Three.js（WebGL 2）、Rapier（WASM）、Vite + React；伺服器為 Colyseus 權威房間
- 主規格：[`docs/FRONTLINE_WEB_PROJECT_SPEC.md`](docs/FRONTLINE_WEB_PROJECT_SPEC.md)

> **目前狀態：Phase 1（瀏覽器 FPS 灰盒）。** 可以在灰盒測試地圖裡走、衝刺、跳、蹲，碰撞與相機已驗證。
> 還沒有武器、多人連線，也還沒有匯入 Blackwood Valley。進度見 [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md)。

## 快速開始

需要 [Bun](https://bun.sh) 1.4 以上與 Node.js 22 LTS。

```bash
bun install
```

```bash
bun run dev
```

開啟 <http://localhost:5173>，按「點擊開始」鎖定滑鼠。建議使用最新版桌面 Chrome 或 Edge，並開啟硬體加速。

## 操作

| 按鍵 | 動作 |
|---|---|
| W A S D（或方向鍵） | 移動 |
| 滑鼠 | 視角 |
| 左 Shift（按住） | 衝刺（只能往前） |
| 空白鍵 | 跳躍 |
| C | 蹲下／站起 |
| Esc | 暫停並釋放滑鼠 |

蹲下刻意不綁 Ctrl：瀏覽器在一般 Pointer Lock 下攔不到 Ctrl+W，邊蹲邊往前走會直接關掉分頁。

暫停選單可以調整滑鼠靈敏度、水平視野、反轉 Y 軸與效能資訊顯示，設定會存在瀏覽器裡。

## 指令

| 指令 | 用途 |
|---|---|
| `bun run dev` | 開發伺服器（http://localhost:5173） |
| `bun run build` | 型別檢查並建置正式版到 `apps/web/dist` |
| `bun run preview` | 預覽正式版（http://localhost:4173） |
| `bun run check` | 型別檢查 + lint + 單元測試 |
| `bun run e2e` | 建置後用 Playwright 在真實瀏覽器跑端到端測試 |

第一次跑 e2e 前，需要安裝 Playwright 的 Chromium：

```bash
bunx playwright install chromium
```

加上 `?debug=1` 可以在正式版開啟除錯介面（`window.__frontline`），e2e 測試就是用它讀取玩家狀態。

## 目錄結構

```
apps/web/              瀏覽器用戶端（Vite + React + Three.js）
  src/app/             React 外殼
  src/ui/              選單、設定、相容性提示
  src/game/            遊戲本體（不經過 React 的每畫格邏輯）
  e2e/                 Playwright 端到端測試
packages/shared/       前後端共用的規則與常數（移動規則等）
docs/                  規格與設計文件
legacy/ue5/            舊版 UE5 C++ 骨架，只作為數值與規則參考，不再開發
```

之後的階段會加入 `apps/game-server`（Colyseus）、`packages/game-config`、`packages/map-schema` 與 `assets/`，見 [`docs/TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md)。

## 文件

| 文件 | 內容 |
|---|---|
| [`FRONTLINE_WEB_PROJECT_SPEC.md`](docs/FRONTLINE_WEB_PROJECT_SPEC.md) | 主規格（以此為準） |
| [`DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) | 階段、驗收結果、待確認事項 |
| [`TECHNICAL_ARCHITECTURE.md`](docs/TECHNICAL_ARCHITECTURE.md) | 模組、資料流、程式規則 |
| [`NETWORKING_SPEC.md`](docs/NETWORKING_SPEC.md) | 權威伺服器、預測、命中驗證 |
| [`ASSET_PIPELINE.md`](docs/ASSET_PIPELINE.md) | Blender → glTF 流程與地圖資料 |
| [`ART_DIRECTION.md`](docs/ART_DIRECTION.md) | 美術方向與畫面預算 |
| [`PHASE0_ENVIRONMENT_REPORT.md`](docs/PHASE0_ENVIRONMENT_REPORT.md) | 環境與資產盤點 |
