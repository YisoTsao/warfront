# 資產流程（Blender → Web）

> 依據：`FRONTLINE_WEB_PROJECT_SPEC.md` §8。Phase 2 開始實作。
> **目前阻礙**：repo 與開發環境中都找不到 Blackwood Valley 的 Blender 原始檔，詳見 `PHASE0_ENVIRONMENT_REPORT.md` §4。

## 1. 原則

- `.blend` 原始檔保留不動，不覆蓋、不刪除。瀏覽器只載入最佳化後的執行期資產，絕不載入整個 Blender 專案。
- 視覺網格與遊戲碰撞網格分開。精細的樹、岩石、建築不會自動變成物理碰撞體。
- 不假設任意 Blender shader node、Geometry Nodes、程序材質或模擬能直接轉到 Three.js；做不到的效果要烘焙或在 Three.js 重建。
- 不做一個包含整張地圖的巨大 GLB。

## 2. 目錄

```text
assets/
├── blender-source/              原始 .blend（或放在獨立的資產 repo）
├── exported/                    匯出後的 GLB / KTX2
└── maps/
    └── blackwood-valley/
        ├── map-manifest.json    分塊、LOD、碰撞、遊戲標記
        ├── chunks/              地形分塊與道具群組
        └── collision/           簡化碰撞網格
```

大型二進位檔走 Git LFS（`.gitattributes` 已設定 `.blend`、`.glb`、`.ktx2`、`.png`、`.jpg`、`.exr`、`.hdr`、`.wav`、`.ogg` 等）。

## 3. Blender 集合命名

| 集合 | 內容 | 匯出 |
|---|---|---|
| `ENV_Terrain` | 地形 | 依分塊匯出 GLB |
| `ENV_Rocks`、`ENV_Trees`、`ENV_Foliage` | 岩石、樹、植被 | 每種一份網格（含 LOD），擺放位置另存 instance 資料 |
| `ENV_Buildings`、`ENV_Props` | 建築、道具 | 依地標或區域分組匯出 |
| `ENV_Weapons` | 武器模型 | 個別匯出 |
| `COLLISION_Static` | 移動碰撞（低面數） | 匯出為碰撞資料，不渲染 |
| `COLLISION_Bullet` | 子彈碰撞（必要時與移動碰撞不同） | 同上 |
| `GAMEPLAY_SpawnPoints`、`GAMEPLAY_Objectives`、`GAMEPLAY_RestrictedAreas`、`GAMEPLAY_WaterVolumes` | 遊戲標記（empty 加自訂屬性） | 匯出到 `map-manifest.json` |
| `LIGHTING_Reference` | 光照參考 | 不匯出 |

## 4. 匯出流程

1. **檢查**：比例（1 Blender 單位 = 1 公尺）、方向（glTF 匯出時轉為 Y 軸朝上）、樞紐點、套用變換。
2. **材質**：使用 Principled BSDF 相容的 PBR 參數（base color、roughness、metallic、normal、AO）。不支援的效果烘焙成貼圖。
3. **網格**：大型或重複的資產製作 LOD；重複的植被與道具改為 instancing。
4. **匯出 glTF 2.0 / GLB**：使用 Blender 內建 glTF 匯出器，依集合與分塊分別輸出。
5. **壓縮**：幾何用 Meshopt 或 Draco（以量測決定），貼圖轉 KTX2 / Basis Universal。
6. **碰撞**：`COLLISION_*` 匯出成低面數網格或基本形狀，客戶端與伺服器都用同一份。
7. **manifest**：產生 `map-manifest.json`，記錄每個分塊的路徑、邊界、LOD、碰撞資料與遊戲標記。
8. **驗證**：在瀏覽器載入代表性的一小區，檢查材質、比例、方向、碰撞與畫格時間。

匯出步驟最後要寫成可重複執行的腳本（Blender headless + 壓縮工具），不靠手動操作。

## 5. 地圖資料（`map-manifest.json`）

由 `packages/map-schema` 定義 schema，前端與伺服器都驗證。內容至少包含：

- 兩隊的出生點。
- 目標位置與佔領半徑／區域。
- 禁區。
- 淺水與深水區域。
- 掩體與視線阻擋物。
- 子彈碰撞與材質穿透資料（需要時）。
- 地圖邊界與出界回收規則。
- 之後 bot 使用的導航資料（選用）。

遊戲標記用 Blender empty 或明確命名的標記物件，搭配自訂屬性描述設定，不只靠物件名稱。

## 6. 串流與可見度

- 地圖分成數個空間分塊；先載入附近分塊，遠處的視覺資產漸進載入。
- 出生區域的分塊必須載入完成，才允許玩家在那裡出生。
- 使用視錐剔除、距離剔除、LOD、instancing 與依遮蔽分組。
- 高密度植被不能在整張地圖都以最高細節渲染。
- 碰撞幾何與渲染 LOD 無關，永遠使用簡化碰撞網格。
- 增加地圖密度前，先量測記憶體與 draw calls。

## 7. 與 Phase 1 灰盒的關係

Phase 1 的灰盒地圖（`apps/web/src/game/world/grayboxLayout.ts`）已經採用「資料描述 → 建置器分別建立視覺網格與碰撞」的分層。Phase 2 會新增一個以 `map-manifest.json` 為輸入的建置器，灰盒保留為移動與碰撞的回歸測試場景。
