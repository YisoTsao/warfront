# FRONTLINE — 寫實多人 FPS

以 Unreal Engine 5（C++ 為核心、Blueprint 做迭代）開發的寫實現代軍事第一人稱射擊遊戲。
MVP 為 5v5 專用伺服器（Dedicated Server）對戰，未來擴充到 16v16。第一張地圖為 Blackwood Valley（Blender 製作的溫帶森林戰場）。

> 狀態：遊戲核心系統的 C++ 程式碼骨架。**尚未在 UE5 中編譯過**（開發環境無法執行 UE5），第一次編譯可能需要小幅修正。

## 快速開始

1. 安裝 Unreal Engine 5.5（`Frontline.uproject` 的 `EngineAssociation` 為 5.5，其他 5.x 版本可在開啟時轉換）。
2. Windows 上安裝 Visual Studio 2022（含「使用 C++ 的遊戲開發」工作負載）。
3. 右鍵 `Frontline.uproject` → **Generate Visual Studio project files**，開啟 `Frontline.sln`，以 `Development Editor | Win64` 建置。
4. 開啟編輯器，建立一個新關卡（或任何測試關卡），放幾個 `Player Start`：
   - `Player Start Tag` 設為 `Alpha` 或 `Bravo` 即為該隊出生點；沒有 Tag 則兩隊共用。
5. 專案預設 GameMode 已設為 `FLGameMode`，直接按 Play 即可。
   - 測試多人：Play 選單 → Number of Players = 10、Net Mode = **Play As Client**（會自動啟動專用伺服器）。

**不需要任何美術或資料資產就能玩**：沒有角色模型時，系統會用灰盒圓柱（依隊伍上色）代替並改用膠囊體判定命中（上方 25cm 為爆頭區）；沒有武器/兵種資料資產時，會使用內建的預設內容。

## 操作

| 動作 | 鍵鼠 | 手把（預留） |
|---|---|---|
| 移動 / 視角 | WASD / 滑鼠 | 左搖桿 / 右搖桿 |
| 衝刺（按住） | Left Shift | L3 |
| 跳躍（蹲/臥時改為起身） | Space | A |
| 蹲下（切換） | C / Left Ctrl | B |
| 臥倒（切換） | Z | — |
| 開火 / 瞄準（ADS） | 左鍵 / 右鍵 | RT / LT |
| 換彈 | R | X |
| 切換武器 | 滾輪、1、2 | Y |
| 射擊模式 | B | 十字左 |
| 投擲手榴彈 | G | RB |
| 兵種技能 | Q | LB |
| 救援倒地隊友（按住） | E | 十字上 |
| 倒地時放棄（按住 1 秒） | X | — |
| 選擇兵種（下次部署生效） | F1–F4，F5 換主武器 | — |

主控台指令：`SelectClass Medic 1`、`Redeploy`（自殺重生）、`fl.Debug.Weapons 1`（顯示彈道）。

## 架構

```
Source/Frontline/
├── Core/            GameMode（隊伍、出生、友傷、票數、重生）、GameState、PlayerState、共用列舉
├── Player/          FLCharacter、FLCharacterMovementComponent、FLPlayerController、FLInputConfig
├── Combat/          FLHealthComponent（存活 → 倒地 → 死亡、救援、回血）、傷害類型
├── Weapons/         FLWeaponData（資料資產）、FLWeapon（通用 hitscan 武器）、FLInventoryComponent
├── Equipment/       FLEquipmentData、FLThrowable（手榴彈）
├── PlayerClasses/   FLClassDefinition（兵種資料資產）、FLAbility 及四個兵種技能
├── Data/            FLContentRegistry（以 id 解析內容）、FLDefaultContent（內建預設內容）
└── UI/              FLHUD（灰盒測試用 Canvas HUD）
```

### 設計重點

- **資料驅動兵種**：`UFLClassDefinition` 定義血量、衝刺倍率、救援速度、可選主武器、副武器、裝備與技能。角色與控制器內沒有任何兵種專屬邏輯；技能是 `UFLAbility` 子類別（C++ 或 Blueprint），新增兵種只要建立資料資產。
- **可重用武器框架**：一個 `AFLWeapon` 搭配 `UFLWeaponData` 涵蓋突擊步槍、衝鋒槍、DMR、狙擊槍、輕機槍、霰彈槍與手槍。資料包含射速、射擊模式（單發／連發／全自動）、彈匣與備彈、戰術／空倉換彈、逐發裝填、距離衰減、爆頭與四肢倍率、彈丸數、散佈（腰射／瞄準／移動／空中／蹲／臥／連射擴散）、後座力（垂直、水平、偏向、首發、姿勢倍率、自動回復）、ADS 時間與 FOV、模型、特效、音效與動畫。
- **網路模型**：專用伺服器權威。移動（衝刺、臥倒、瞄準）透過 CharacterMovement 的 saved move 旗標做客戶端預測；射擊由客戶端即時表現，伺服器驗證射速、彈藥與射擊原點後，用相同亂數種子重算散佈並判定命中；其他客戶端只收不可靠的特效廣播。
- **只複製 id**：武器、裝備與兵種在網路上只傳 id，由 `UFLContentRegistry` 在各端解析。放在 `/Game/Frontline/Data/{Weapons,Equipment,Classes}` 的資料資產會被 Asset Manager 自動載入，並覆蓋同 id 的內建預設值。
- **姿勢**：臥倒實作為第二段較低的蹲伏高度，沿用引擎的膠囊縮放、阻擋檢查與複製機制；鏡頭高度以「離地高度」平滑過渡。
- **命中判定**：自訂 `Weapon` 追蹤通道（`ECC_GameTraceChannel1`）。有骨架模型時打物理資產（依骨骼名稱判定頭部/四肢），沒有時退回膠囊體。

### 內建預設內容

| 兵種 | 主武器選項 | 裝備 | 技能 | 救援 |
|---|---|---|---|---|
| Assault | 卡賓槍、泵動霰彈槍 | 破片手榴彈 x2 | 戰鬥興奮劑（自我治療 50） | 5 秒、30% 血量 |
| Medic | 衝鋒槍、泵動霰彈槍 | 破片手榴彈 x1 | 治療脈衝（範圍治療隊友） | 2 秒、滿血 |
| Support | 輕機槍、卡賓槍 | 破片手榴彈 x1 | 彈藥補給（範圍補滿彈藥與裝備） | 5 秒、30% 血量 |
| Recon | 栓動狙擊槍、精準射手步槍 | 破片手榴彈 x1 | 標定（前方錐形範圍標記敵人 8 秒） | 5 秒、30% 血量 |

所有兵種的副武器皆為手槍。數值是起始調整值，請以資料資產覆寫。

## 專用伺服器

`FrontlineServer.Target.cs` 已就緒，但伺服器版本需要**從原始碼建置的 UE5**（Launcher 版沒有 server 執行檔）。打包後以 `FrontlineServer.exe /Game/Maps/<Map> -log` 啟動，客戶端用主控台 `open <IP>` 連線。`Config/DefaultGame.ini` 中 `MaxPlayers=10`（5v5）。

## 尚未包含 / 下一步

- 角色、武器模型與動畫（目前為灰盒）、音效與 Niagara 特效資產。
- Blackwood Valley 地圖（Blender 製作、匯入 UE5 的流程與規格待規格書後續章節）。
- 延遲補償（伺服器回溯）、子彈下墜與穿透、彈道投射物。
- 部署畫面、計分板、擊殺訊息等 UMG 介面。
- 目標模式（如據點占領）、小隊系統、載具。
- 規格書第 4 節之後的內容（原文在「Pi」處截斷）。
