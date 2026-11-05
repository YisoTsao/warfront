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
| 碰撞物件 | `collider = "heightfield"`、`grid_rows`、`grid_cols` | 規則格狀地形輸出成高度場（比三角網格小很多）。頂點依列優先排列：列沿 +Z、欄沿 +X；每格的對角線連接 (欄+1, 列) 與 (欄, 列+1)，視覺網格要用同樣的切法 |
| 碰撞物件 | `layer = "movement"` | 只擋人不擋子彈（例如鐵絲網） |
| 碰撞物件 | `material` | `dirt`、`rock`、`wood`、`metal`… 決定命中特效與腳步聲 |
| 出生點 | `team = "alpha"` / `"bravo"` | 不填則兩隊共用；名稱含 Alpha / Bravo 也可以 |
| 出生點 | `yaw_degrees` | 覆寫朝向（預設用 empty 的 -Z 軸） |
| 據點 | `objective_id`、`display_name`、`radius`、`initial_owner` | 半徑預設為 empty 的縮放 |
| 禁區 | `team`、`grace_seconds` | 只限制某一隊；進入後幾秒判定死亡 |
| 水域 | `depth = "deep"` / `"shallow"` | |
| 太陽 | `sun_color`、`sun_intensity`、`sky_color`、`fog_color`、`fog_near`、`fog_far`、`hemisphere_sky`、`hemisphere_ground`、`hemisphere_intensity` | |
| LOD 資料庫物件 | `lod_library = true` | 只提供網格，不擺在場景裡 |
| 網格（mesh） | `cull_distance` | 超過這個距離（公尺）不畫，用於蕨類、小石頭等小物件 |
| 場景（scene） | `frontline_build` | 建置參數：`chunk_size`、`terrain_chunk_size`、`stream_distance`、`lod_distances`、`shared_library`；命令列參數優先 |
| 場景（scene） | `frontline_water` | 水面資料：`flow_texture`、`depth_texture`（GLB 內的貼圖名稱）、`origin`、`size`、`max_depth`、`max_speed` → `manifest.water` |
| 材質 | `frontline_shader = "water"` / `"waterfall"` | 前端換成水面 shader（流動、深淺、平面反射倒影、泡沫） |
| 材質 | `frontline_foliage = true` | 葉片：前端把法線改成從樹冠往外、不依正反面翻轉，並加一點透光 |

### 3.3 LOD

網格命名為 `Pine_LOD0`、`Pine_LOD1`…。場景中擺放使用 `Pine_LOD0` 的物件；`Pine_LOD1` 放一個帶 `lod_library = true` 的物件即可。map-build 會為每組 instancing 產生 LOD0 與 LOD1 兩組。前端以**逐實例 LOD** 切換：每 0.25 秒依每個實例與玩家的距離，把實例分配到 LOD0 或 LOD1 的 InstancedMesh（玩家移動超過 1.5 m 才重算），draw call 數量固定。非 instancing 的物件則依與包圍盒的距離整個切換。

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

輸出（`assets/maps/<id>/`）：

| 檔案 | 內容 |
|---|---|
| `map-manifest.json` | 分塊、出生點、據點、禁區、水域、環境光；前端與伺服器都會驗證 |
| `collision.json` | 方塊、三角網格、高度場；前端與伺服器用同一份 |
| `chunks/*.glb` | 地形分塊（永遠載入）與細節分塊（依距離串流） |
| `library.glb` | 共用網格庫（`shared_library` 開啟時）：出現兩次以上的網格與其 LOD 只寫一次；分塊裡只有實例變換與 `extras.library_mesh` |
| `textures/*` | 共用貼圖（預設開啟）：依內容雜湊命名，同一張只寫一次；材質以 `extras.frontline_textures` 記錄路徑，前端共用同一個 GPU 貼圖 |

輸出報告包含每個分塊的大小與 instancing 數量、碰撞數量、出生點與據點數量，以及警告（例如某隊沒有出生點、有物件不在任何集合內）。manifest 與碰撞資料在寫出前都會經過 schema 驗證。

新地圖要在 `apps/web/src/game/world/maps.ts` 的清單中加上 id 與名稱，主選單才會顯示。

## 5. 森林谷地（blender-mcp-asset-generator）

`blender-mcp-asset-generator` 在 Blender 內程序化產生 500 m × 500 m 的森林河谷（phase1 地形、phase2 水體、phase3 植被、phase4 岩石、phase5 道路與建築）。它的輸出不是單一個依本專案慣例分好集合的 GLB，而是多個 GLB 加上實例清單與高度圖，所以另外寫了轉換器：

```bash
bun run maps:forest -- --source ../blender-mcp-asset-generator/output
```

1. **組成來源 GLB**（`assets/blender-source/exports/forest-valley.glb`，不進版控，可隨時重建）：
   - 地形：phase5 整地後的 1025 高度圖每隔一點取樣（513 × 513，約 1 m 間距），切成 4 × 4 視覺分塊；同一組樣本輸出成碰撞高度場。底色貼圖（2048²）依植被密度、坡度、碎石、道路、壕溝、營地與水域畫成。
   - 水面與瀑布：`water_meshes.glb`；水域判定由水面遮罩與水深圖切成 8 m 方塊（深度超過 1.3 m 為深水）。水面材質標記 `frontline_shader = water / waterfall`，Blender 的流向圖（流向、流速、泡沫）與水深圖轉成兩張 1024² 貼圖，經場景的 `frontline_water` 設定寫進 `manifest.water`，前端的水面 shader 使用。
   - 樹種與林區：phase3 先把地圖分成六種林區（河岸林、闊葉林、混交林、松林、雲杉林、枯木林；依相對高度、坡向、濕度加上低頻雜訊決定，邊界有窄的混合帶），每種林區有自己的密度與樹種比例；部分山脈由大尺度雜訊選中，樹林一路長到山坡上（坡度上限 +8°、樹線較高、密度 ×2.6）。樹種共 7 種：松、雲杉、橡、楓、赤楊、樺、枯木。林區圖（`forest_zones_513.png`，編號見 `vegetation_meta.json` 的 `zones`）用來畫地形底色：河岸林地面較潮濕、枯木林有焦黑痕跡。
   - 樹皮：Poly Haven 的 CC0 掃描貼圖（Blender 專案的 `assets/textures/bark/`，來源見該目錄的 `SOURCE.md`），UV 依貼圖實際尺寸換算，匯入時保留貼圖、底色設為白色（×0.8）。樺樹維持程序化白樹皮。
   - 地表起伏：Blender 的高度圖很平滑，匯入時加上 3 m／9 m 尺度的小起伏，陡坡再加上不規則的岩層（層高 2.5–6 m 隨位置變化）與沿坡溝槽；道路、營地、建築、橋與水域周圍不加。植被與岩石的高度依整地後的地形重新貼地，碰撞高度場與視覺網格一致。
   - 地形細節（`manifest.terrain`）：六種 Poly Haven CC0 掃描貼圖（草地、林地落葉、岩石、泥土路面、碎石、河岸泥地，見 `assets/textures/terrain/SOURCE.md`），權重圖依植被密度、坡度、碎石、道路與水域畫成；另有路面橫向座標（車轍）與積水圖。前端地形 shader 以高度混合各圖層、岩石用三向投影、遠處淡回底色，並在水底畫焦散。
   - 小地圖（`manifest.minimap`）：俯視衛星圖（地形底色 × 山影、水深上色、每棵樹的樹冠與陰影），小地圖與完整地圖（按 M 開關）都畫在它上面。
   - 樹的 LOD：LOD0（55 m 內）、LOD1（130 m 內，葉片卡 22–40%）、LOD2（遠景，樹幹 5%、葉片卡 8% 並放大 1.9 倍）。LOD1 以後不投影；某一層沒有實例時不畫。
   - 植被與岩石：依 `vegetation_instances.json`、`rock_instances.json` 擺放（Blender 座標 Z 朝上、公分 → 本專案 Y 朝上、公尺），套用 phase5 在 Blender 內做的清理（道路、壕溝、橋、營地附近移除，伐木場 75% 的樹砍掉）並依整地高度差重新貼地。LOD 由 meshoptimizer 產生：岩石 LOD0 簡化到 30%、LOD1 6%；樹的葉片卡依間隔保留 30–40%。
   - 建築：`structures.glb`（道路網格不匯入，已畫進地形底色）；碰撞用 `environment_layout.json` 的方塊與膠囊（膠囊的軸向由結構網格頂點的主成分推算）。樹幹、原木、岩石另外加上縮小的方塊碰撞，避免隱形牆。
   - 遊戲標記：兩隊出生點用 phase5 的 HQ 出生建議點（南方 HQ = alpha、北方 HQ = bravo）；征服據點 A 橋梁、B 農舍、C 教堂遺跡、D 伐木場；敵方基地禁區；地圖四周只擋人的邊界牆。
   - 材質：Blender 的程序化材質匯出後是白色，依原始材質腳本的顏色重新指定；葉片改成 alpha 測試並提高亮度（Blender 靠半透明散射提亮），標記 `frontline_foliage`。
   - 太陽：Blender 燈光預設 `noon`（仰角 58°、方位 165°）。
   - 草與花：不匯入約 22 萬個實例，改輸出 512² 密度圖（R = 草、G = 花，已扣掉道路、步道、壕溝、營地、水域、陡坡與碎石），經場景的 `frontline_grass` 設定寫進 `manifest.grass`，前端 GPU 草地系統依此產生；草的顏色取地形底色貼圖。
2. **map-build**：產生 `assets/maps/forest-valley/`（提交到 repo；執行期資料約 11 MB，不走 LFS，見 `.gitattributes`）。

目前沒有匯入的內容：樹樁與枝堆（phase5 沒有匯出網格）、phase6–7 的遊戲標記與燈光腳本（尚未在 Blender 執行）。

## 6. 執行期

- 前端：地形分塊先載入；細節分塊在 `streamDistance` 內載入，超出 1.3 倍後卸載並釋放 GPU 資源；同時最多 3 個下載。玩家出生前會先載入必要分塊。
- 植被品質會改變串流距離（低 60%、中 85%、高 100%）。
- 伺服器只讀 `map-manifest.json` 與 `collision.json`，不載入視覺分塊。
- 天空：物理天空（Rayleigh／Mie 散射）畫進立方體貼圖，當作背景與 PMREM 環境貼圖；亮度以地圖霧色為目標自動校正，霧色取天空地平線的顏色。
- 雲層（`CloudLayer.ts`）：跟著鏡頭的半球疊在天空背景上，FBM 雲平面隨風飄移，地平線淡出到霧色。
- 草地（`GrassField.ts`）：依 `manifest.grass` 的密度圖在玩家周圍產生草叢（兩次 draw call），高度取碰撞高度場；範圍依植被品質。
- 角色：`assets/characters/` 以 `/characters/` 提供（與地圖相同，開發時直接讀檔、建置時複製）。士兵與步槍都是 Quaternius 的 CC0 模型，來源見 `assets/characters/SOURCE.md`，由 `bun run --cwd tools/map-build characters` 產生。
- 水面 shader（`WaterMaterial.ts`）：平面反射倒影（場景沿鏡頭附近的水面高度鏡射，以畫面 35–50% 的解析度另畫一次，不含水面與草地、不重算陰影；水面高度與鏡射平面相差超過約 1.5 m 時改用天空顏色）；兩相位 flowmap 沿流向推動多層雜訊法線與風吹漣漪；Schlick Fresnel 混合水體與倒影；陽光用 GGX 鏡面反射；依水深吸收顏色並在岸邊淡出；急流與岸邊的條紋泡沫；遠處法線與泡沫減弱避免閃爍。倒影解析度依植被品質（低：關閉、中 35%、高 50%）。瀑布沿 UV 往下流。
- 有共用網格庫時，玩家出生前先載入 `library.glb`；分塊載入後把佔位網格換成網格庫的幾何與材質。共用的幾何、材質與貼圖在卸載分塊時不釋放。

## 7. 尚未實作

- KTX2 貼圖轉換：前端已支援 KTX2（`/basis/` 轉碼器），map-build 尚未自動轉檔（需要 `toktx`）。森林谷地目前用 PNG／JPEG（共 1.7 MB）。
- 遮蔽剔除與導航網格（bot 目前用直線前進加繞路）。
