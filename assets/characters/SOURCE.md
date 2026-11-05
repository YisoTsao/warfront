# 角色資產來源

| 檔案 | 來源 | 作者 | 授權 |
|---|---|---|---|
| `soldier/soldier.glb` | SWAT，https://poly.pizza/m/Btfn3G5Xv4 | Quaternius | CC0 1.0（公有領域） |
| `weapons/ak.glb` | Character Soldier 裡的 AK 網格，https://poly.pizza/m/PpLF4rt4ah | Quaternius | CC0 1.0（公有領域） |

- CC0：可商用、可修改、可散布，不需要標示作者（本專案仍記錄來源方便追蹤）。
- 由 `bun run --cwd tools/map-build characters -- --swat <SWAT.glb> --soldier-pack <Character Soldier.glb>` 產生：
  士兵原樣複製；步槍取出 AK 網格，轉成「槍托在原點、槍口朝 −Z、全長 0.9 m」，金屬部分壓暗。
- 士兵：約 1.5 MB、24 段動畫（Idle_Gun、Walk、Run、Run_Shoot、Run_Back／Left／Right、Death、HitRecieve、Roll 等）。
  前端（`apps/web/src/game/animation/RiggedSoldier.ts`）使用 Idle_Gun、Walk、Run、Death；蹲下、臥倒與雙手握槍由程式 IK 疊加。
- 先前使用的 three.js 範例 Soldier.glb（Mixamo 授權）已移除。
