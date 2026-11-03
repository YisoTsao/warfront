# FRONTLINE Web 移植計畫

> 狀態：計畫草案，尚未開始實作。
> 範圍：把目前的 UE5 C++ 遊戲骨架（`Source/Frontline/`，約 5,500 行）改成可以在瀏覽器遊玩的多人 FPS。

---

## 1. 結論摘要

- UE5 的 C++ 無法直接在瀏覽器執行，UE5 也已不再支援 HTML5 輸出，所以這是**換引擎重寫**，不是語法翻譯。
- 程式碼目前規模小、尚未在 UE5 編譯過，也還沒有美術資產，**現在是轉向成本最低的時間點**。
- 大約一半的邏輯（武器數值、傷害衰減、散佈與後座力、生命狀態機、遊戲規則、兵種與技能）是純規則，可以幾乎一對一移植到 TypeScript。
- 另一半依賴引擎（角色移動預測、碰撞追蹤、網路複製、輸入、HUD、特效、動畫），需要用 web 技術重新實作。
- 「寫實」畫面要降低期待：目前設定啟用的 Lumen、Nanite、Virtual Shadow Maps 在瀏覽器沒有對等功能。

---

## 2. 現況盤點

| 項目 | 現況 |
|---|---|
| 引擎 | Unreal Engine 5.5，C++ 為主，Blueprint 為輔 |
| 程式碼 | 51 個檔案，`.h/.cpp` 合計 5,515 行；最大的是 `FLCharacter.cpp`（861 行）與 `FLWeapon.cpp`（752 行） |
| 編譯狀態 | README 註明尚未在 UE5 編譯過 |
| 美術資產 | 無（灰盒圓柱代替角色，內建預設數值代替資料資產） |
| 網路 | 專用伺服器權威，`NetServerMaxTickRate=60`，`MaxPlayers=10`（5v5），未來目標 16v16 |
| 渲染設定 | Lumen GI 與反射、Nanite、Virtual Shadow Maps、DX12 |
| 尚未實作 | 延遲補償（伺服器回溯）、子彈下墜與穿透、UMG 介面、據點模式、小隊、載具、Blackwood Valley 地圖 |

---

## 3. 目標技術架構

### 3.1 技術選型

| 層 | 選擇 | 理由 |
|---|---|---|
| 語言 | TypeScript（strict） | 前後端共用同一份規則程式碼 |
| 套件管理 | pnpm workspace（monorepo） | 便於 `shared` 套件被前後端引用 |
| 前端渲染 | Three.js（WebGL2，日後可評估 WebGPU） | 生態系完整、glTF 支援好；備案為 Babylon.js |
| 前端建置 | Vite | 開發伺服器快，支援 WASM |
| 物理與碰撞 | Rapier（`@dimforge/rapier3d-compat`，WASM） | 前端與 Node 伺服器可以用同一套物理，命中判定結果一致 |
| 伺服器 | Node.js + TypeScript | 直接重用 `shared` 的規則程式碼 |
| 傳輸 | MVP 用 WebSocket（二進位訊息）；之後評估 WebTransport 或 WebRTC DataChannel | WebSocket 最容易部署；TCP 遺失封包時會卡住後續資料，量測後再決定是否升級 |
| UI | DOM 疊在 canvas 上（React 或原生皆可，建議 React） | 取代 `FLHUD` 的 Canvas 繪製與之後的 UMG |
| 測試 | Vitest（單元與模擬）、Playwright（瀏覽器 e2e） | 容器內已有 Chromium 與 Playwright |

### 3.2 目錄結構

```
warfront/
├── packages/
│   └── shared/            純規則，不依賴瀏覽器或 Node API
│       ├── content/       武器、裝備、兵種 JSON 與型別
│       ├── combat/        傷害衰減、散佈、後座力、生命狀態機
│       ├── rules/         隊伍、票數、友傷、重生、兵種選擇
│       ├── abilities/     四個兵種技能
│       ├── movement/      移動模擬（前後端共用，用於預測）
│       ├── net/           訊息格式、序列化
│       └── math/          seeded RNG、向量、錐形隨機
├── apps/
│   ├── client/            Three.js、輸入、相機、HUD、特效、音效、預測與插值
│   └── server/            權威模擬、連線管理、驗證、命中判定、延遲補償
├── assets/                glTF 模型、貼圖、音效（大型檔案用 Git LFS）
├── tools/                 Blender 匯出腳本、內容驗證腳本
└── docs/
```

`shared` 只能是純函式和純資料，不可以引用 `three`、DOM 或 Node 模組，這樣才能在前端預測與伺服器驗證時算出一樣的結果。

### 3.3 座標與單位轉換

UE 與 Three.js 的慣例不同，移植數值時要統一轉換，建議在 `shared/math` 只保留一套慣例：

| 項目 | UE5 | Web 版 |
|---|---|---|
| 長度 | 公分 | **公尺**（數值除以 100） |
| 上方 | +Z | **+Y** |
| 慣用手 | 左手座標系 | 右手座標系 |
| 角度 | `FRotator`（Pitch、Yaw，度） | 以弧度為內部單位，資料檔仍用度 |
| 重力 | `-980` cm/s² | `-9.8` m/s² |

需要換算的現有數值（cm → m）：

| 數值 | UE | Web |
|---|---|---|
| 衝刺速度 `SprintSpeed` | 600 | 6.0 |
| 臥倒速度 `ProneSpeed` | 90 | 0.9 |
| 蹲下半高 `StandardCrouchHalfHeight` | 60 | 0.60 |
| 臥倒半高 `ProneHalfHeight` | 34 | 0.34 |
| 手榴彈投擲速度 `ThrowSpeed` | 1500 | 15 |
| 手榴彈內／外半徑 | 250 / 800 | 2.5 / 8 |
| 治療脈衝、補給半徑 | 800 | 8 |
| 標定距離 `Range` | 20000 | 200 |
| 射擊原點容許誤差 `MaxOriginError` | 200 | 2.0 |
| 灰盒爆頭區 | 膠囊頂部 25 | 0.25 |

武器的傷害衰減距離原本就以公尺為單位，不用換算。

---

## 4. 模組對照表

分類：**移植**＝邏輯照搬到 TS；**重寫**＝概念保留但實作全換；**刪除**＝web 版不需要。

| 現有檔案 | 分類 | Web 版位置 | 說明 |
|---|---|---|---|
| `Core/FLTypes.h` | 移植 | `shared/content/types.ts` | 列舉改成字串 union，隊伍顏色與名稱一併搬 |
| `Weapons/FLWeaponData.h/.cpp` | 移植 | `shared/content/weapon.ts` + JSON | 數值欄位全保留；美術欄位改為 glTF、音效路徑 |
| `Data/FLDefaultContent.cpp` | 移植 | `shared/content/defaults/*.json` | 7 把武器、手榴彈、4 個兵種的預設數值轉成 JSON |
| `Data/FLContentRegistry` | 移植 | `shared/content/registry.ts` | 以 id 查詢；JSON 載入後覆蓋同 id 預設值的規則保留 |
| `Combat/FLHealthComponent` | 移植 | `shared/combat/health.ts` | 存活→倒地→死亡、流血計時、救援、回血；改成純狀態加 `tick(dt)` |
| `Combat/FLDamageTypes.h` | 移植 | `shared/combat/damage.ts` | 改成 `'bullet' \| 'explosive'` |
| `Weapons/FLWeapon`（射速、射擊模式、彈藥、換彈、bloom） | 移植 | `shared/combat/weapon-state.ts` | 計時器（`FTimerHandle`）改成以模擬時間推進的狀態機 |
| `Weapons/FLWeapon`（散佈、後座力、彈丸） | 移植 | `shared/combat/spread.ts`、`recoil.ts` | 需改用 seeded RNG，見第 6 節 |
| `Weapons/FLWeapon`（射線追蹤、命中部位） | 重寫 | `server/combat/hitscan.ts`、`client/combat/` | `LineTraceSingleByChannel` 改用 Rapier raycast；骨骼部位改用命名 hitbox |
| `Weapons/FLWeapon`（特效、音效、動畫） | 重寫 | `client/fx/`、`client/audio/` | Niagara 改 Three.js 粒子；音效改 Web Audio |
| `Weapons/FLInventoryComponent` | 移植 | `shared/combat/inventory.ts` | 武器欄位、裝備數量、切換、投擲冷卻 |
| `Equipment/FLEquipmentData` | 移植 | `shared/content/equipment.ts` | 數值保留 |
| `Equipment/FLThrowable` | 重寫 | `server/entities/grenade.ts` | 彈跳拋物線用 Rapier 剛體；範圍衰減傷害公式移植 |
| `PlayerClasses/FLClassDefinition` | 移植 | `shared/content/class.ts` + JSON | 技能從類別參照改成技能 id |
| `PlayerClasses/FLAbility`（4 個技能） | 移植 | `shared/abilities/` | 冷卻與四個技能的規則照搬；範圍查詢改用伺服器實體列表 |
| `Core/FLGameMode` | 移植 | `server/match/game-mode.ts`（規則放 `shared/rules`） | 分隊、出生點、友傷、票數、重生、比賽重啟 |
| `Core/FLGameState`、`FLPlayerState` | 重寫 | `shared/net/snapshot.ts` | 不再靠引擎複製，改為快照欄位 |
| `Player/FLCharacter`（救援、姿勢、生命狀態處理） | 移植 | `shared/player/` | 規則照搬，Actor 結構拆成資料加系統 |
| `Player/FLCharacter`（相機、灰盒外觀、第一人稱模型） | 重寫 | `client/player/` | 相機高度平滑、ADS FOV 過渡 |
| `Player/FLCharacterMovementComponent` | 重寫 | `shared/movement/` + Rapier character controller | 衝刺、臥倒、瞄準減速、只能向前衝刺的規則保留；預測與修正要自己寫 |
| `Player/FLPlayerController` | 重寫 | `client/net/`、`client/ui/` | 兵種選擇、重生指令改為網路訊息 |
| `Player/FLInputConfig`（EnhancedInput） | 重寫 | `client/input/` | Pointer Lock、鍵盤、滑鼠、Gamepad API；按鍵配置沿用 README 表格 |
| `UI/FLHUD` | 重寫 | `client/ui/hud/` | 準星（依散佈縮放）、彈藥、血量、倒地計時、票數、命中提示 |
| `Frontline.Build.cs`、`*.Target.cs`、`Frontline.uproject` | 刪除 | `package.json`、`vite.config.ts` | |
| `Config/*.ini` | 刪除 | `shared/config.ts`、伺服器環境變數 | tick rate、人數上限等設定搬過去 |
| 主控台指令（`SelectClass`、`Redeploy`、`fl.Debug.Weapons`） | 重寫 | `client/dev/console.ts` | 開發用指令與彈道除錯繪製 |

---

## 5. 網路模型

目前的設計是伺服器權威，這點保留。UE 原本代為處理的部分要自己實作：

### 5.1 訊息流程

- **客戶端 → 伺服器**：每個 tick 送一筆輸入指令（序號、移動軸、視角、按鍵位元、時間戳記）。
- **伺服器 → 客戶端**：固定頻率送世界快照（玩家位置、姿勢、生命狀態、武器 id、彈藥等）；單次事件（命中確認、擊殺、爆炸）另外送。
- 只傳內容 id（武器、裝備、兵種）的設計保留，兩端各自用 registry 查數值。

### 5.2 移動

| UE 原本提供 | Web 版做法 |
|---|---|
| `FSavedMove` 與壓縮旗標 | 客戶端保留已送出但未確認的輸入佇列 |
| 伺服器修正 | 收到快照後回到伺服器位置，重播未確認的輸入（reconciliation） |
| 模擬代理的平滑 | 其他玩家以約 100 ms 延遲做快照插值 |
| 膠囊縮放（蹲、臥） | Rapier capsule 換尺寸，起身前先做頭頂空間檢查 |

建議伺服器模擬 60 Hz（沿用目前設定），快照先送 20–30 Hz，量測後調整。

### 5.3 射擊

沿用現有流程：客戶端立即表現（後座力、特效、預測彈藥），送出原點、方向與亂數種子；伺服器驗證射速、彈藥、原點後重算散佈並判定命中。

需要補上的部分：

- **延遲補償**：web 延遲通常比原生客戶端高，建議在 W4 就做伺服器回溯（保存最近約 1 秒的玩家 hitbox 歷史，依客戶端時間戳記回溯判定）。README 原本也把它列為下一步。
- **命中部位**：骨骼名稱比對（`head`、`neck`、`arm`…）改成每個角色固定的 hitbox 集合（頭、軀幹、四肢），伺服器不需要載入動畫骨架。

---

## 6. 移植時一併處理的現有問題

以下是閱讀程式碼時發現的設計問題，移植時順便處理比較省事：

1. **亂數種子由客戶端決定**：`FLWeapon::FireShotLocal` 用 `FMath::Rand()` 產生種子再送給伺服器，伺服器照單全收。作弊者可以挑選讓散佈最小的種子。
   - 建議：種子改為 `hash(伺服器配發的對戰種子, 玩家 id, 射擊序號)`，兩端都能算出，但客戶端無法挑選。
2. **兩端散佈可能不一致**：伺服器用自己的 bloom、移動速度、姿勢計算散佈，與客戶端預測值可能不同，造成「客戶端看到命中、伺服器判定沒中」。
   - 建議：散佈輸入（bloom、是否移動、姿勢）也由 `shared` 的同一份函式計算，並在測試中驗證同一輸入序列在兩端得到相同結果。
3. **後座力使用非決定性亂數**：`ApplyRecoil` 用 `FMath::FRandRange`。後座力只影響本機視角，可以不改，但改用 seeded RNG 後重播與測試會比較容易。

---

## 7. 開發階段

每個階段結束時都要有可以實際操作或可以自動測試的成果。

### W0 — 專案骨架

- 建立 pnpm workspace、TypeScript strict、ESLint、Prettier、Vitest。
- 建立 `packages/shared`、`apps/client`、`apps/server` 空殼，以及 `pnpm check`、`pnpm test`、`pnpm build`。
- 把 UE5 程式碼移到 `legacy-ue5/` 或打上 git tag（見第 11 節待決定事項）。
- **驗收**：三個套件都能 build；CI 跑 check 與 test。

### W1 — 共用規則（不含畫面）

- 移植內容資料（7 把武器、手榴彈、4 個兵種）為 JSON，並加上 schema 驗證。
- 移植傷害衰減、散佈、後座力、彈丸錐形隨機、生命狀態機、射擊與換彈狀態機、物品欄、技能冷卻、遊戲規則（友傷、票數、擊殺計分）。
- **驗收**：Vitest 單元測試覆蓋上述規則；同一種子產生相同彈丸方向；數值與 `FLDefaultContent.cpp` 一致。

### W2 — 單機灰盒

- Three.js 場景、灰盒地形、Rapier 角色控制器。
- Pointer Lock 滑鼠視角、WASD、衝刺、跳躍、蹲、臥、ADS 與 FOV 過渡。
- Hitscan 對靜止假人、命中部位、傷害數字、HUD（準星、彈藥、血量）。
- **驗收**：瀏覽器可以完整試玩所有武器與姿勢；Playwright 截圖與基本流程測試通過。

### W3 — 權威伺服器與移動同步

- Node 伺服器、WebSocket 連線、輸入指令、世界快照、移動預測與修正、他人插值。
- 加入延遲與丟包模擬（例如 100 ms、2% 遺失）供開發測試。
- **驗收**：兩個瀏覽器分頁連到本機伺服器，在模擬延遲下移動不抖動、不會被大幅拉回。

### W4 — 戰鬥網路化

- 射擊指令、伺服器驗證、延遲補償、命中確認、倒地與救援、放棄、回血、手榴彈、四個技能。
- 套用第 6 節的種子與散佈修正。
- **驗收**：無頭（headless）伺服器模擬測試覆蓋射速作弊、原點作弊、彈藥作弊被拒絕；兩個客戶端可互相擊倒、救援、擊殺。

### W5 — 對戰流程

- 分隊、出生點（隊伍標籤與佔用檢查）、重生倒數、兵種與主武器選擇畫面、計分板、擊殺訊息、票數歸零結束與自動重開。
- **驗收**：10 個模擬客戶端（可用 bot）完成一整場 5v5 對戰。

### W6 — 內容與表現

- 角色與武器 glTF 模型、第一與第三人稱動畫、音效、槍口火光、曳光彈、命中特效、布娃娃（可選）。
- Blackwood Valley：Blender 匯出 glTF（Draco 或 Meshopt 壓縮、KTX2 貼圖），另外匯出簡化碰撞網格。
- **驗收**：效能預算內（第 8 節）可以遊玩完整地圖。

### W7 — 效能、部署與測試

- 效能量測與優化、資產分段載入、伺服器部署（容器化）、配對或房間清單。
- 實際網路環境下 10 人測試。
- **驗收**：達成第 8 節效能預算；10 人測試沒有嚴重同步問題。

---

## 8. 效能預算（初版，需在 W2 實測後修正）

| 項目 | 目標 |
|---|---|
| 畫面更新率 | 中階筆電（內顯）1080p 下維持 60 FPS |
| Draw calls | 每幀 300 以下 |
| 首次下載 | 進入遊戲前 50 MB 以下，其餘背景載入 |
| 伺服器 | 單一 Node 程序以 60 Hz 跑 10 人，每 tick 低於 8 ms |
| 頻寬 | 每位玩家下行 30 KB/s 以下 |

---

## 9. 測試策略

| 層 | 工具 | 內容 |
|---|---|---|
| 規則 | Vitest | 傷害、散佈、後座力、生命狀態、遊戲規則；決定性（同輸入同輸出） |
| 伺服器模擬 | Vitest + 無頭伺服器 | 假客戶端送指令，驗證驗證邏輯與作弊拒絕 |
| 網路品質 | 自訂延遲與丟包代理 | 預測修正幅度、插值平順度 |
| 客戶端 | Playwright | 開始遊戲、射擊、換彈、HUD 狀態、截圖比對 |
| 對戰 | bot 客戶端 | 10 人完整一場 |

---

## 10. 風險與對策

| 風險 | 影響 | 對策 |
|---|---|---|
| 瀏覽器效能不足 | 畫面卡頓、寫實感不足 | 提早在 W2 量測；美術採中等多邊形與烘焙光照；接受與 UE5 的畫面落差 |
| WebSocket 在丟包時卡頓 | 射擊手感差 | 抽象化傳輸層，W7 前評估 WebTransport 或 WebRTC DataChannel |
| 自寫預測與修正出錯 | 角色被拉回、命中判定不一致 | 移動模擬放在 `shared` 並寫決定性測試；開發期內建延遲模擬 |
| 瀏覽器客戶端容易被修改 | 作弊 | 維持伺服器權威；種子由伺服器規則決定；所有指令都驗證 |
| 大型資產下載慢 | 首次進入等待太久 | glTF 壓縮、KTX2、分段載入、CDN 快取 |
| 物理在前後端結果不同 | 命中或移動不一致 | 前後端使用同一版本 Rapier；以伺服器結果為準 |

---

## 11. 待決定事項

開始 W0 之前需要確認：

1. **UE5 程式碼怎麼處理**：建議打上 tag（例如 `ue5-foundation`）後移到 `legacy-ue5/` 當作參考，等 W5 完成再刪除。也可以直接保留在主線。
2. **渲染引擎**：預設 Three.js；如果更重視內建工具（物理整合、檢視器），可以改用 Babylon.js。
3. **寫實程度**：web 版的目標畫面要接受到什麼程度（例如「接近 2015 年左右的 PC 射擊遊戲」或「風格化寫實」）。
4. **16v16 是否仍是目標**：會影響伺服器架構與頻寬預算，建議 MVP 先只承諾 5v5。
5. **部署環境**：自架主機、雲端容器或遊戲伺服器託管服務，決定 W7 的做法。
