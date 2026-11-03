# 技術架構

> 依據：`FRONTLINE_WEB_PROJECT_SPEC.md` §2、§16。本文件說明實際採用的結構與規則；與主規格衝突時以主規格為準。

## 1. 整體架構

```text
桌面瀏覽器
├── React 外殼（apps/web/src/app、src/ui）
│   └── 選單、設定、相容性提示、載入畫面；之後加入大廳、HUD、計分板
├── 遊戲本體（apps/web/src/game）── 每畫格邏輯，不經過 React
│   ├── core/      生命週期、固定步長迴圈、設定、相容性檢查
│   ├── input/     鍵盤、滑鼠、Pointer Lock、按鍵綁定
│   ├── renderer/  Three.js 渲染器、場景、光源、context 遺失處理
│   ├── physics/   Rapier 初始化與靜態碰撞
│   ├── world/     地圖資料與建置（目前為灰盒）
│   ├── player/    角色控制器、相機
│   └── debug/     效能面板、測試用除錯介面
│
└── HTTPS / WSS（Phase 4 起）
    ├── Colyseus 權威伺服器（apps/game-server）
    └── 後端 API（Supabase Auth + PostgreSQL，需要帳號時）

packages/shared  ── 前端預測與伺服器共用的規則與常數
```

## 2. 目前已實作（Phase 1）

| 模組 | 檔案 | 職責 |
|---|---|---|
| 移動規則 | `packages/shared/src/movement/` | 速度、加速度、衝刺條件、跳躍、姿勢、被牆擋住時的速度修正。純函式，伺服器之後可以用同一份重播 |
| 固定步長 | `apps/web/src/game/core/FixedStepLoop.ts` | 模擬以 1/60 秒固定推進；單一畫格最多補 0.25 秒；回傳插值係數 |
| 遊戲生命週期 | `core/Game.ts` | 建立渲染器、物理、地圖、玩家、輸入；主迴圈；釋放資源 |
| 設定 | `core/settings.ts` | 靈敏度、水平視野、反轉 Y、效能面板；驗證並存在 localStorage |
| 相容性 | `core/compatibility.ts` | 啟動前檢查 WebGL 2、WebAssembly、Pointer Lock |
| 輸入 | `input/InputManager.ts`、`keyBindings.ts` | 只在 Pointer Lock 期間接受輸入；失焦、切分頁、解除鎖定時清除按鍵；跳躍與蹲下為「按下事件」，每個模擬步驟取用一次 |
| 渲染 | `renderer/Renderer.ts` | WebGL 2、ACES 色調映射、方向光陰影、霧；ResizeObserver；context 遺失通知 |
| 物理 | `physics/PhysicsWorld.ts` | Rapier World、靜態盒狀碰撞 |
| 地圖 | `world/grayboxLayout.ts`、`GrayboxMap.ts` | 灰盒資料（坡道、樓梯、跳台、低矮通道、牆角）與建置；視覺網格與碰撞分開建立 |
| 角色 | `player/PlayerController.ts` | Rapier 運動學角色控制器、膠囊碰撞、姿勢切換與頭頂檢查、出界回收 |
| 相機 | `player/CameraRig.ts` | yaw/pitch（±89° 不翻轉）、水平視野換算、眼高平滑、落地下沉 |
| 除錯 | `debug/DebugStats.ts`、`debugHook.ts` | FPS、畫格時間 p95/max、draw calls、三角形數；`?debug=1` 時提供 `window.__frontline` |

### 2.1 主迴圈

```text
requestAnimationFrame（Three.js setAnimationLoop）
├── 套用這一畫格累積的滑鼠位移 → 相機 yaw/pitch（每畫格，反應最快）
├── FixedStepLoop.advance(畫格時間)
│   └── 每個 1/60 秒：取輸入 → PlayerController.step → world.step
├── 以插值係數內插腳底位置 → 相機位置、眼高、視野
├── 渲染
└── 記錄效能數據（每 0.25 秒直接寫入 DOM 一次，不經過 React）
```

### 2.2 角色控制器重點

- 膠囊半徑 0.34 m，站姿高 1.84 m、蹲姿高 1.2 m；換姿勢時調整膠囊並維持腳底位置。
- 站起前用略細的站姿膠囊做重疊測試，頭頂有障礙就維持蹲姿。
- 坡度 ≤ 45° 可以爬，≥ 50° 會滑下；台階 ≤ 0.35 m 自動跨上；下坡貼地 0.3 m。
- **預期速度與實際速度分開**：
  - 預期速度是依輸入加速得到的速度，作為下一步的起點。在地面上不修正，Rapier 的沿牆滑動與自動跨步才拿得到完整輸入（若在撞到台階立面時把速度歸零，就上不了樓梯）。
  - 在空中時，移除真正擋住角色的牆的分量，避免撞牆後殘留看不見的慣性。
  - 對外回報（效能面板、之後的網路同步）使用實際速度＝位移 ÷ dt。

### 2.3 React 的邊界

- React 只在生命週期事件改變 state：載入完成、Pointer Lock 變化、context 遺失。
- 遊戲本體以動態 `import()` 延後載入，選單外殼先顯示。
- e2e 測試以 MutationObserver 驗證：遊玩中 React 管理的 DOM 沒有任何變動。

## 3. 後續階段的模組（尚未建立）

依主規格 §16，之後會加入：

| 位置 | 內容 | 階段 |
|---|---|---|
| `apps/game-server/` | Colyseus 房間、固定 tick 模擬、驗證、命中判定、模式規則、配對、結果回報、觀測 | Phase 4–6 |
| `packages/game-config/` | 武器、兵種、模式資料（數值來源見 `PHASE0_ENVIRONMENT_REPORT.md` §3） | Phase 3 起 |
| `packages/map-schema/` | 地圖 manifest 與遊戲標記的 schema | Phase 2 |
| `assets/` | Blender 原始檔、匯出資產、地圖資料 | Phase 2 |
| `apps/web/src/game/` 內新增 `weapons/`、`combat/`、`animation/`、`audio/`、`vfx/`、`network/` | | Phase 3 起 |

## 4. 程式規則

主規格 §16 的規則，加上本專案的補充：

- TypeScript strict（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- 只用 Bun 管理套件，不加入 npm、Yarn、pnpm 的 lockfile。
- 前後端必須一致的常數一律放在 `packages/shared` 或 `packages/game-config`。
- `packages/shared` 只能放純函式與純資料，不能引用 `three`、DOM 或 Node API。
- 伺服器專用的權威程式碼不能進入瀏覽器 bundle。
- 不把遊戲邏輯集中在單一 React 元件、單一 game manager 或單一 Colyseus room 類別。
- 每畫格執行的程式碼避免配置新物件（插值位置等使用重複利用的物件）。
- 單位：公尺、秒、弧度（設定與資料檔可以用度）；Y 軸朝上；yaw = 0 時面向 -Z。

## 5. 驗證

| 指令 | 內容 |
|---|---|
| `bun run check` | `tsc -b`、ESLint、Vitest（規則、設定、迴圈、地圖資料） |
| `bun run build` | 型別檢查 + Vite 正式版建置 |
| `bun run e2e` | 建置後以 Playwright 在 Chromium 驗證 Phase 1 檢查清單 |

e2e 的移動判斷以「模擬步驟紀錄」為準（`startRecording` / `stopRecording`），不受渲染 FPS 影響，沒有 GPU 的 CI 也能得到一致結果。

## 6. 已知限制

- Rapier 的 WASM 以 base64 內嵌，遊戲 chunk 約 4.9 MB（gzip 1.8 MB）。Phase 2 處理資產載入時一起評估改用獨立 `.wasm` 檔與快取。
- 按鍵綁定已是資料驅動（`keyBindings.ts`），但還沒有重新綁定的 UI。
- 尚未評估 WebGPU，也還沒在 Firefox 測試（主規格安排在第一個里程碑之後）。
