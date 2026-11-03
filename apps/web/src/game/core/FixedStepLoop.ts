/**
 * 固定步長累加器。渲染頻率不固定，但物理與移動模擬一律以固定 dt 推進，
 * 之後客戶端預測要與伺服器的固定 tick 重播一致，這是必要條件。
 */
export class FixedStepLoop {
  private accumulator = 0;

  constructor(
    readonly stepSeconds: number,
    /** 單一畫格最多補跑幾步，避免分頁切回來時卡死（spiral of death）。 */
    readonly maxStepsPerFrame: number,
  ) {}

  /**
   * 推進 frameSeconds，對每個固定步呼叫 step。
   * 回傳 0–1 的插值係數，供渲染在前後兩個模擬狀態之間內插。
   */
  advance(frameSeconds: number, step: (dt: number) => void): number {
    this.accumulator += Math.max(0, frameSeconds);
    let steps = 0;
    while (this.accumulator >= this.stepSeconds && steps < this.maxStepsPerFrame) {
      step(this.stepSeconds);
      this.accumulator -= this.stepSeconds;
      steps++;
    }
    if (steps === this.maxStepsPerFrame && this.accumulator >= this.stepSeconds) {
      // 落後太多：丟棄剩餘時間，而不是在之後的畫格慢慢追。
      this.accumulator = 0;
    }
    return this.accumulator / this.stepSeconds;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
