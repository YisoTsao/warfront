# 地形細節貼圖來源

全部取自 [Poly Haven](https://polyhaven.com)，授權 **CC0 1.0**（公有領域：可商用、可修改、可散布，不需要標示作者；這裡仍記錄來源方便追蹤）。
下載 1K（`*_diff_1k.jpg`、`*_nor_gl_1k.jpg`）後縮成 512 px、JPEG 品質 88。法線貼圖是 OpenGL 慣例（+Y 朝上）。

| 檔案 | Poly Haven 資產 | 實際尺寸 | 地形圖層 |
|---|---|---|---|
| `leafy_grass_*` | https://polyhaven.com/a/leafy_grass | 2.0 m | 草地（基底） |
| `forest_floor_*` | https://polyhaven.com/a/forest_floor | 2.14 m | 林地落葉 |
| `rock_face_04_*` | https://polyhaven.com/a/rock_face_04 | 2.0 m | 岩壁、山坡（三向投影） |
| `stony_dirt_path_*` | https://polyhaven.com/a/stony_dirt_path | 2.17 m | 泥土路面 |
| `rocky_gravel_*` | https://polyhaven.com/a/rocky_gravel | 1.81 m | 碎石坡 |
| `mud_forest_*` | https://polyhaven.com/a/mud_forest | 2.35 m | 河岸泥地 |

森林谷地匯入時（`bun run maps:forest`）把這些圖放進來源 GLB，由 map-build 寫到地圖的 `textures/`，經 `manifest.terrain` 給前端的地形 shader 使用。
