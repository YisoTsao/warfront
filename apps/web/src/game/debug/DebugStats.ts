import type * as THREE from 'three';
import type { CharacterSnapshot } from '@frontline/simulation';

const SAMPLE_COUNT = 240;
const REFRESH_SECONDS = 0.25;

export interface FrameStats {
  fps: number;
  frameMsAverage: number;
  frameMsP95: number;
  frameMsMax: number;
  drawCalls: number;
  triangles: number;
}

/**
 * 收集畫格時間與渲染統計，每 0.25 秒直接寫入 DOM 一次。
 * 刻意不經過 React state，避免渲染迴圈觸發 React 重新渲染。
 */
export class DebugStats {
  private readonly samples = new Float32Array(SAMPLE_COUNT);
  private sampleIndex = 0;
  private sampleCount = 0;
  private sinceRefresh = 0;
  private latest: FrameStats = { fps: 0, frameMsAverage: 0, frameMsP95: 0, frameMsMax: 0, drawCalls: 0, triangles: 0 };
  private output: HTMLElement | null = null;

  constructor(
    private readonly rendererInfo: THREE.WebGLInfo,
    private readonly rendererLabel: string,
  ) {}

  attach(element: HTMLElement | null): void {
    this.output = element;
  }

  get stats(): FrameStats {
    return this.latest;
  }

  /** 每個渲染畫格呼叫一次（在 render 之後，才拿得到這一格的 draw calls）。 */
  record(frameSeconds: number, player: CharacterSnapshot, yaw: number, pitch: number): void {
    this.samples[this.sampleIndex] = frameSeconds * 1000;
    this.sampleIndex = (this.sampleIndex + 1) % SAMPLE_COUNT;
    this.sampleCount = Math.min(SAMPLE_COUNT, this.sampleCount + 1);
    this.sinceRefresh += frameSeconds;
    if (this.sinceRefresh < REFRESH_SECONDS) {
      return;
    }
    this.sinceRefresh = 0;
    this.latest = this.compute();
    if (this.output) {
      this.output.textContent = this.format(player, yaw, pitch);
    }
  }

  private compute(): FrameStats {
    const values = Array.from(this.samples.subarray(0, this.sampleCount)).sort((a, b) => a - b);
    const total = values.reduce((sum, v) => sum + v, 0);
    const average = values.length > 0 ? total / values.length : 0;
    const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0;
    const max = values[values.length - 1] ?? 0;
    return {
      fps: average > 0 ? 1000 / average : 0,
      frameMsAverage: average,
      frameMsP95: p95,
      frameMsMax: max,
      drawCalls: this.rendererInfo.render.calls,
      triangles: this.rendererInfo.render.triangles,
    };
  }

  private format(player: CharacterSnapshot, yaw: number, pitch: number): string {
    const s = this.latest;
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);
    return [
      `${s.fps.toFixed(0)} FPS  ${s.frameMsAverage.toFixed(1)} ms（p95 ${s.frameMsP95.toFixed(1)} / max ${s.frameMsMax.toFixed(1)}）`,
      `Draw calls ${s.drawCalls}  三角形 ${s.triangles.toLocaleString()}`,
      `渲染 ${this.rendererLabel}`,
      `位置 ${player.feet.x.toFixed(2)}, ${player.feet.y.toFixed(2)}, ${player.feet.z.toFixed(2)}`,
      `速度 ${speed.toFixed(2)} m/s  垂直 ${player.velocity.y.toFixed(2)}`,
      `狀態 ${player.stance} / ${player.locomotion}${player.grounded ? '' : '（空中）'}`,
      `視角 yaw ${deg(yaw)}°  pitch ${deg(pitch)}°`,
    ].join('\n');
  }
}
