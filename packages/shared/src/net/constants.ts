/**
 * 網路與模擬頻率。客戶端預測與伺服器必須用同一個固定步長，重播才會一致。
 * 起始值依主規格 §10.2：伺服器 30 Hz，快照 15 Hz（每 2 個 tick 一次）。
 */
export const TICK_RATE = 30;
export const TICK_SECONDS = 1 / TICK_RATE;
export const SNAPSHOT_EVERY_TICKS = 2;
/** 遠端玩家插值延遲（秒），約 2 個快照間隔 */
export const INTERPOLATION_DELAY_SECONDS = 0.12;
/** 延遲補償最多回溯的時間（秒） */
export const MAX_REWIND_SECONDS = 0.25;
