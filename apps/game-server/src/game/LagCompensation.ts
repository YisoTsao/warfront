import { MAX_REWIND_SECONDS, TICK_RATE, type Stance, type Vec3 } from '@frontline/shared';

export interface PoseRecord {
  feet: Vec3;
  yaw: number;
  stance: Stance;
  hittable: boolean;
}

const MAX_TICKS = Math.ceil(MAX_REWIND_SECONDS * TICK_RATE) + 2;

/**
 * 延遲補償：保存最近幾個 tick 每位玩家的 hitbox 姿勢。開火時依客戶端畫面上的 tick
 * （輸入框的 vt）回溯，最多回溯 MAX_REWIND_SECONDS；超過上限就用最舊的紀錄。
 */
export class LagCompensation {
  private readonly history = new Map<number, Map<number, PoseRecord>>();

  record(tick: number, poses: Map<number, PoseRecord>): void {
    this.history.set(tick, poses);
    for (const t of this.history.keys()) {
      if (t < tick - MAX_TICKS) {
        this.history.delete(t);
      }
    }
  }

  /**
   * 取得指定 tick 的姿勢（限制在可回溯範圍內）。優先使用該 tick 或之前最近的紀錄；
   * 本 tick 的姿勢要到 tick 結束才記錄，所以「目前 tick」會取到上一個 tick。
   */
  posesAt(requestedTick: number, currentTick: number): { tick: number; poses: Map<number, PoseRecord> } | null {
    const earliest = currentTick - Math.ceil(MAX_REWIND_SECONDS * TICK_RATE);
    const tick = Math.max(earliest, Math.min(currentTick, requestedTick));
    for (let t = tick; t >= earliest - 1; t--) {
      const poses = this.history.get(t);
      if (poses) {
        return { tick: t, poses };
      }
    }
    for (let t = tick + 1; t <= currentTick; t++) {
      const poses = this.history.get(t);
      if (poses) {
        return { tick: t, poses };
      }
    }
    return null;
  }

  clear(): void {
    this.history.clear();
  }
}
