# 技術架構

> 依據：`FRONTLINE_WEB_PROJECT_SPEC.md` §2、§16。本文件說明實際採用的結構與規則；與主規格衝突時以主規格為準。

## 1. 整體架構

```text
桌面瀏覽器
├── React 外殼（apps/web/src/app、src/ui）── 主選單、伺服器列表、部署畫面、HUD、計分板、設定
└── 遊戲本體（apps/web/src/game）── 每畫格邏輯，不經過 React；以動態 import 延後載入
    ├── core/      GameBase 主迴圈、TrainingGame（單機）、OnlineGame（連線）、設定、畫質控制
    ├── input/     鍵盤、滑鼠、滾輪、Pointer Lock、可重新綁定的按鍵
    ├── renderer/  WebGL 2 渲染器、武器模型疊加 pass、暈影後處理、動態解析度
    ├── world/     MapRuntime、GLB 分塊串流與 LOD、環境光、灰盒地圖
    ├── player/    本機玩家、相機（ADS、後座力、落地）、腳步聲
    ├── weapons/   武器欄、開火流程、第一人稱武器模型
    ├── network/   GameTransport 介面與 Colyseus 實作
    ├── remote/    遠端玩家插值
    ├── animation/ 士兵模型（AnimationMixer）
    ├── combat/    靶場假人
    ├── vfx/       物件池特效
    ├── audio/     WebAudio 空間音效
    ├── hud/       HUD store、戰術地圖
    └── debug/     效能面板、測試用除錯介面

        │ WSS（Colyseus）
        ▼
對戰伺服器（apps/game-server）── 常駐 Node 程序
├── room/      MatchRoom：加入驗證、訊息結構驗證、限流、重連、tick 推進、送出快照
├── game/      Match（純遊戲邏輯）、玩家、輸入佇列、血量、延遲補償、模式、出生點、手榴彈、bot
├── persistence/  對戰結果回報（目前 JSONL）
└── metrics.ts、logger.ts、index.ts（/health、/metrics、/rooms、/client-errors）

共用套件（前後端都使用同一份程式碼）
├── packages/shared       移動規則、數學、可重現亂數、網路協定、tick 常數
├── packages/simulation   Rapier 世界、角色控制器、hitbox、彈道、武器狀態機、輸入框轉換
├── packages/game-config  武器、配件、手榴彈、兵種、模式資料
└── packages/map-schema   地圖 manifest、碰撞資料、Blender 命名慣例、灰盒地圖

工具
└── tools/map-build       Blender 匯出的 GLB → 執行期地圖資料
```

## 2. 為什麼前後端共用 simulation

客戶端預測與伺服器權威必須算出相同結果，修正才會少。因此以下程式碼只有一份，前端與伺服器都直接使用：

| 模組 | 用途 |
|---|---|
| `SimWorld` | 由同一份 `collision.json` 建立 Rapier 世界；碰撞層分為擋移動、擋子彈、兩者 |
| `CharacterBody` | 運動學角色控制器（站、蹲、臥、跳、坡道、樓梯、牆面滑動）；狀態可存取與還原（預測修正需要） |
| `frames.ts` | 輸入框 → 角色輸入、武器輸入的轉換 |
| `WeaponState` | 以模擬時間推進的武器狀態機（射速、模式、彈藥、換彈、bloom） |
| `ballistics.ts` | 散佈公式、射擊種子、彈丸方向 |
| `hitboxes.ts` | 頭、軀幹、四肢的膠囊 hitbox 與射線判定 |

Rapier 的 compat 版本把 WASM 內嵌在 JS 中，瀏覽器與 Node 都能直接使用。

## 3. 主迴圈（用戶端）

```text
requestAnimationFrame
├── 套用滑鼠位移 → 相機 yaw / pitch（每畫格）
├── FixedStepLoop：每 1/30 秒
│   ├── 單機：本機玩家 → 武器 → 命中（靶場假人）
│   └── 連線：組輸入框 → 預測（同一套轉換）→ 武器 → 記錄預測 → 送出
├── 內插本機位置、更新相機與視野
├── 地圖串流與 LOD、遠端玩家插值、特效、音效聆聽者、戰術地圖
├── 渲染：主場景 → 清深度 → 武器模型 → 暈影
└── 效能紀錄、動態解析度
```

React 只在事件發生時更新：HUD 數值透過外部 store（`useSyncExternalStore`）只在值改變時通知；準星大小、效能面板、小地圖由遊戲迴圈直接寫入 DOM 或 canvas。e2e 以 MutationObserver 驗證遊玩中 React 管理的 DOM 不會持續變動。

## 4. 伺服器 tick

```text
每 1/30 秒（Match.step）
├── bot 產生輸入框
├── 每位玩家：依額度處理佇列中的輸入框（每個只處理一次、依序）
│   └── 移動 → 切槍 → 武器狀態機 → 射擊（延遲補償 + 命中判定）→ 手榴彈 → 技能 → 救援
├── 物理世界推進
├── 手榴彈飛行與爆炸
├── 血量（流血、回血）、禁區與地圖邊界
├── 模式規則（佔領、票數、勝負、階段）
├── 重生
└── 記錄 hitbox 姿勢（延遲補償）
每 2 tick：每位玩家各自的快照；每 0.5 秒：對戰狀態（分數、據點、計分板）
```

## 5. 地圖資料流

```text
Blender（.blend）                 blender-mcp-asset-generator 的輸出
  → 匯出 glTF                     → bun run maps:forest（組成同樣慣例的 GLB）
    （assets/blender-source/exports/<id>.glb）
  → tools/map-build
  → assets/maps/<id>/
       map-manifest.json   出生點、據點、禁區、水域、環境光、分塊清單
       collision.json      方塊、三角網格與高度場碰撞
       chunks/*.glb        視覺分塊（Meshopt、instancing、LOD）
       library.glb         共用網格庫（分塊只放實例變換）
       textures/*          共用貼圖
  → 瀏覽器：/maps/<id>/（Vite 開發伺服器直接讀取，建置時複製到 dist）
  → 伺服器：MAPS_DIR/<id>/（只讀 manifest 與 collision）
```

## 6. 程式規則

- TypeScript strict（含 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）；只用 Bun 管理套件。
- 前後端必須一致的常數與規則一律在共用套件；`shared`、`game-config`、`map-schema` 不能引用 Three.js、DOM 或 Node API。
- 伺服器專用程式（`apps/game-server`）不會進入瀏覽器 bundle。
- 不把遊戲邏輯集中在單一 React 元件、單一 game manager 或 Colyseus room：`MatchRoom` 只處理網路，規則在 `Match` 與各模組。
- 單位：公尺、秒、弧度；Y 軸朝上；yaw = 0 時面向 -Z。

## 7. Bundle

| 檔案 | 大小（gzip） | 內容 |
|---|---|---|
| `index-*.js` | 268 KB（84 KB） | React 外殼、選單、設定 |
| `GameBase-*.js` | 5.2 MB（1.9 MB） | Three.js、Rapier（含 WASM）、遊戲本體——進入遊戲時才載入 |
| `OnlineGame-*.js` | 188 KB（60 KB） | Colyseus SDK 與連線邏輯 |
| `basis/` | 585 KB | KTX2 轉碼器（只在地圖使用 KTX2 貼圖時下載） |
