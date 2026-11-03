# 資產流程（Blender → GLB → 執行期地圖）

> 依據：`FRONTLINE_WEB_PROJECT_SPEC.md` §8。本文件描述已實作的 `tools/map-build`。
> **Blackwood Valley 的原始檔尚未提供**；流程已用「範例谷地」驗證（`bun run maps:sample`）。

## 1. 原則

- `.blend` 原始檔保留不動。瀏覽器只載入轉換後的執行期資料，不載入 Blender 專案。
- 視覺網格與碰撞網格分開；精細的樹、岩石、建築不會自動變成碰撞體。
- 不假設任意 shader node、Geometry Nodes、程序材質或模擬能直接轉到 Three.js；做不到的效果要烘焙。
- 不做一個包含整張地圖的巨大 GLB：map-build 會自動切成分塊。

## 2. 目錄

```text
assets/
├── blender-source/
│   ├── blackwood-valley.blend          原始檔（Git LFS，或放在獨立的資產 repo）
│   └── exports/blackwood-valley.glb    從 Blender 匯出的 glTF（map-build 的輸入）
└── maps/
    └── blackwood-valley/               map-build 的輸出（瀏覽器與伺服器都讀這裡）
        ├── map-manifest.json
        ├── collision.json
        └── chunks/*.glb
```

## 3. Blender 端的慣例

### 3.1 集合與角色

以頂層 empty（或集合匯出成的父節點）命名，物件也可以用自訂屬性 `frontline_role` 指定角色（優先）。

| 名稱（前綴） | 用途 | map-build 的處理 |
|---|---|---|
| `ENV_Terrain` | 地形分塊、水面 | 地形分塊，一開始就載入 |
| `ENV_Rocks`、`ENV_Trees`、`ENV_Foliage`、`ENV_Buildings`、`ENV_Props` | 視覺物件 | 依 64 m 分塊，依距離串流；同一網格出現 4 次以上自動合併為 GPU instancing |
| `ENV_Weapons` | 武器模型 | 不放進地圖 |
| `COLLISION_Static` | 碰撞（擋人與子彈） | 輸出到 collision.json，不渲染 |
| `COLLISION_Bullet` | 只擋子彈的碰撞 | 同上，layer = bullet |
| `GAMEPLAY_SpawnPoints` | 出生點（empty） | manifest.spawns |
| `GAMEPLAY_Objectives` | 據點（empty） | manifest.objectives |
| `GAMEPLAY_RestrictedAreas` | 禁區（立方體 empty） | manifest.restrictedAreas |
| `GAMEPLAY_WaterVolumes` | 水域（立方體 empty） | manifest.waterVolumes（深水移動速度 50%、淺水 80%） |
| `LIGHTING_Reference` | 名稱含 `Sun` 的 empty | 太陽方向（empty 的 -Z 軸）與環境設定 |

### 3.2 自訂屬性（glTF extras）

| 物件 | 屬性 | 說明 |
|---|---|---|
| 碰撞物件 | `collider = "box"` | 以物件的包圍盒（含旋轉與縮放）輸出方塊碰撞；名稱以 `UBX_` 或 `BOX_` 開頭也可以。否則輸出三角網格 |
| 碰撞物件 | `layer = "movement"` | 只擋人不擋子彈（例如鐵絲網） |
| 碰撞物件 | `material` | `dirt`、`rock`、`wood`、`metal`… 決定命中特效與腳步聲 |
| 出生點 | `team = "alpha"` / `"bravo"` | 不填則兩隊共用；名稱含 Alpha / Bravo 也可以 |
| 出生點 | `yaw_degrees` | 覆寫朝向（預設用 empty 的 -Z 軸） |
| 據點 | `objective_id`、`display_name`、`radius`、`initial_owner` | 半徑預設為 empty 的縮放 |
| 禁區 | `team`、`grace_seconds` | 只限制某一隊；進入後幾秒判定死亡 |
| 水域 | `depth = "deep"` / `"shallow"` | |
| 太陽 | `sun_color`、`sun_intensity`、`sky_color`、`fog_color`、`fog_near`、`fog_far`、`hemisphere_sky`、`hemisphere_ground`、`hemisphere_intensity` | |
| LOD 資料庫物件 | `lod_library = true` | 只提供網格，不擺在場景裡 |

### 3.3 LOD

網格命名為 `Pine_LOD0`、`Pine_LOD1`…。場景中擺放使用 `Pine_LOD0` 的物件；`Pine_LOD1` 放一個帶 `lod_library = true` 的物件即可。map-build 會為每組 instancing 產生 LOD0 與 LOD1 兩組，前端依距離切換（預設 70 m、160 m）。

### 3.4 匯出設定（Blender glTF 2.0）

- 格式：glTF Binary（`.glb`）；+Y Up（預設）。
- 包含：Custom Properties（必須勾選，遊戲標記靠它）、Selected / Visible 依需要。
- 幾何：Apply Modifiers、UVs、Normals、Vertex Colors；不要勾選 Draco（map-build 會用 Meshopt 壓縮）。
- 單位：1 Blender 單位 = 1 公尺；物件套用縮放與旋轉後再擺放 empty。
- 材質：Principled BSDF（base color、roughness、metallic、normal）。

## 4. 執行 map-build

```bash
bun run maps:build -- --input assets/blender-source/exports/blackwood-valley.glb --id blackwood-valley --name "Blackwood Valley"
```

選項：`--out <目錄>`（預設 `assets/maps/<id>`）、`--chunk-size 64`、`--no-compress`。

輸出報告包含每個分塊的大小與 instancing 數量、碰撞數量、出生點與據點數量，以及警告（例如某隊沒有出生點、有物件不在任何集合內）。manifest 與碰撞資料在寫出前都會經過 schema 驗證。

新地圖要在 `apps/web/src/game/world/maps.ts` 的清單中加上 id 與名稱，主選單才會顯示。

## 5. 執行期

- 前端：地形分塊先載入；細節分塊在 `streamDistance` 內載入，超出 1.3 倍後卸載並釋放 GPU 資源；同時最多 3 個下載。玩家出生前會先載入必要分塊。
- 植被品質會改變串流距離（低 60%、中 85%、高 100%）。
- 伺服器只讀 `map-manifest.json` 與 `collision.json`，不載入視覺分塊。

## 6. 尚未實作

- KTX2 貼圖轉換：前端已支援 KTX2（`/basis/` 轉碼器），map-build 尚未自動轉檔（需要 `toktx`）。範例谷地使用頂點色，沒有貼圖。
- 遮蔽剔除與導航網格（bot 目前用直線前進加繞路）。
