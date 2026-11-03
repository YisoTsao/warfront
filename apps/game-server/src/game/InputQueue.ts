import type { InputFrame } from '@frontline/shared';
import { idleFrame, repeatFrame } from '@frontline/simulation';

/** 佇列最多保留的輸入框（約 0.27 秒），超過代表客戶端送太快或時間被加速。 */
const MAX_QUEUE = 8;
/** 連續幾個 tick 沒有收到輸入就改用閒置輸入（約 0.5 秒） */
const STARVATION_TICKS = 15;

/**
 * 每個玩家的輸入佇列。伺服器每個 tick 取一個輸入框；
 * 序號必須遞增（重複或過舊的直接丟棄），沒有輸入時重複上一個（清掉邊緣按鈕）。
 */
export class InputQueue {
  private readonly queue: InputFrame[] = [];
  private last: InputFrame | null = null;
  private starved = 0;
  private lastSeq = -1;
  /** 被丟棄的輸入框數量（重複、過舊、溢出） */
  rejected = 0;
  overflow = 0;

  push(frame: InputFrame): boolean {
    if (frame.s <= this.lastSeq || this.queue.some((f) => f.s === frame.s)) {
      this.rejected++;
      return false;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.overflow++;
      this.queue.shift();
    }
    this.queue.push(frame);
    this.queue.sort((a, b) => a.s - b.s);
    return true;
  }

  /** 取出下一個收到的輸入框（沒有則回傳 null，不重複舊的）。 */
  take(): InputFrame | null {
    const frame = this.queue.shift();
    if (!frame) {
      return null;
    }
    this.last = frame;
    this.lastSeq = frame.s;
    this.starved = 0;
    return frame;
  }

  /** 取下一個要處理的輸入框（沒有新輸入時重複上一個）。 */
  next(): { frame: InputFrame; fresh: boolean } {
    const frame = this.queue.shift();
    if (frame) {
      this.last = frame;
      this.lastSeq = frame.s;
      this.starved = 0;
      return { frame, fresh: true };
    }
    this.starved++;
    if (!this.last || this.starved > STARVATION_TICKS) {
      return { frame: idleFrame(this.last), fresh: false };
    }
    return { frame: repeatFrame(this.last), fresh: false };
  }

  /** 最後處理的序號（回報給客戶端作為 ack） */
  get ack(): number {
    return Math.max(0, this.lastSeq);
  }

  get pending(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
