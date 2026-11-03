# Phase 0 — 環境與資產盤點報告

> 對應 `docs/FRONTLINE_WEB_PROJECT_SPEC.md` §18 Phase 0 與 §19 Task A。
> 盤點日期：2026-11-03。盤點環境：Claude Code 雲端容器（Linux，無 GPU）。

## 1. 工具鏈

| 工具 | 版本 | 備註 |
|---|---|---|
| Bun | 1.4.4 | 套件管理與指令執行；lockfile 為 `bun.lock` |
| Node.js | 22.23.4（LTS） | Vite、Playwright 執行環境 |
| TypeScript | 6.0.3 | 未採用 7.x：`typescript-eslint` 8.72 的 peer 範圍為 `<6.1.0` |
| Vite | 8.3.5 | |
| React | 19.3.1 | |
| Three.js | 0.187.0 | |
| Rapier（`@dimforge/rapier3d-compat`） | 0.21.0 | WASM 以 base64 內嵌，不需額外打包設定 |
| Vitest | 5.1.0 | |
| ESLint | 10.14.0 + typescript-eslint 8.72.1 + react-hooks 7.1.1 | |
| Playwright | 1.63.0 | 與容器預裝的 Chromium（`/opt/pw-browsers`）同版 |
| Blender | **未安裝** | 見第 4 節 |

## 2. 瀏覽器與 GPU

| 項目 | 結果 |
|---|---|
| 瀏覽器 | Playwright Chromium 1.63（headless） |
| GPU | **沒有**（容器無 `/dev/dri`） |
| WebGL 2 | 可用，但是軟體繪圖：`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` |
| CPU / RAM | 4 核心 / 15 GB |

**影響**：這個環境只能驗證「行為」，不能驗證效能。灰盒場景在 1280×720 的 SwiftShader 下只有約 4–6 FPS，這不代表實際玩家電腦的表現。規格 §3.3 的 60 FPS 目標必須在約定的參考 PC 上量測（見 `DEVELOPMENT_PLAN.md` 的「待確認事項」）。

## 3. 既有程式碼盤點

重構前 repo 內容：

| 內容 | 狀態 | 處理 |
|---|---|---|
| UE5 C++ 遊戲骨架（`Source/Frontline/`，51 個檔案、5,515 行） | 從未在 UE5 編譯過 | 移到 `legacy/ue5/`，保留作為規則與數值參考，**不再開發** |
| `Config/*.ini`、`Frontline.uproject` | UE 專用 | 一併移到 `legacy/ue5/` |
| `docs/WEB_PORT_PLAN.md`（上一版移植計畫） | 已被本規格取代 | 刪除，有用的內容整併到新文件 |
| 瀏覽器端程式碼 | 不存在 | 本次新建 |

可重用的部分（數值與規則，不是程式碼）：

| 舊檔案 | 可重用內容 | 預計使用階段 |
|---|---|---|
| `FLCharacterMovementComponent.cpp` | 走路 3.6、蹲走 2.0、衝刺 6.0 m/s，加速度 18 m/s²，跳躍 3.8 m/s，空中控制 0.15，只能往前衝刺（內積 0.6） | **已用於 Phase 1**（`packages/shared/src/movement/constants.ts`） |
| `FLCharacter.cpp` | 膠囊半徑 0.34 m、半高 0.92 m，蹲姿半高 0.60 m，預設水平視野 90° | **已用於 Phase 1** |
| `FLDefaultContent.cpp`、`FLWeaponData.h` | 7 把武器的射速、彈匣、傷害衰減、散佈、後座力數值 | Phase 3、Phase 7 |
| `FLHealthComponent.cpp` | 存活→倒地→死亡狀態機、流血、回血 | Phase 5（倒地為選用） |
| `FLGameMode.cpp` | 分隊、出生點佔用檢查、友傷、計分 | Phase 5、6 |
| `FLAbility.cpp`、`FLClassDefinition.h` | 四個兵種與技能 | Phase 7 |
| `FLWeapon.cpp` 的網路設計 | 伺服器重算散佈、驗證射速與原點 | Phase 5（並修正客戶端自選亂數種子的問題，見 `NETWORKING_SPEC.md`） |

## 4. Blackwood Valley Blender 資產盤點

**結果：找不到任何 Blackwood Valley 的 Blender 檔案或匯出資產。**

- repo 內沒有 `.blend`、`.glb`、`.fbx` 或貼圖檔。
- 整個容器檔案系統搜尋 `*.blend` 與 `*blackwood*`，沒有結果。
- 容器內沒有安裝 Blender，即使拿到檔案也無法在這裡檢查版本、集合、材質或匯出。

規格要求紀錄的項目（Blender 版本、地圖尺寸、集合結構、貼圖尺寸、材質設定、哪些資產可直接匯出）**目前都無法填寫**。

**這是 Phase 2 的阻礙。** 需要專案負責人提供：

1. Blackwood Valley 的 `.blend` 原始檔（建議放在獨立的資產 repo，或本 repo 的 `assets/blender-source/` 並走 Git LFS）。
2. 製作時使用的 Blender 版本。
3. 若有外部貼圖或資產庫，一併提供或說明路徑。

收到後依 `ASSET_PIPELINE.md` 補完這一節的盤點。

## 5. 缺少的工具與阻礙

| 項目 | 影響 | 需要的處理 |
|---|---|---|
| Blackwood Valley 原始檔 | Phase 2 無法開始 | 由專案負責人提供 |
| Blender（4.x） | 無法檢查與匯出地圖資產 | 在美術工作機上執行匯出；之後可在 CI 加 Blender headless 匯出 |
| 參考 PC 規格 | 無法驗收效能目標 | 由專案負責人指定 CPU、GPU、RAM、瀏覽器版本 |
| GPU | 雲端容器只能做行為測試 | 效能量測在參考 PC 上進行 |

## 6. 後續更新（2026-11-03）

- Blackwood Valley 原始檔仍未提供。為了驗證 Phase 2 流程，`tools/map-build` 附帶一個依相同 Blender 匯出慣例產生的「範例谷地」（`bun run maps:sample`）；真正的地圖到位後走同一條流程。
- `legacy/ue5/` 的數值與規則已全部移植到 `packages/game-config` 與 `apps/game-server`；依專案負責人決定保留到 2026-11-10。
