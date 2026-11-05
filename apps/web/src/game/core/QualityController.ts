import type { Renderer } from '../renderer/Renderer';
import type { Effects } from '../vfx/Effects';
import { GRASS_QUALITY, type GrassQuality } from '../world/GrassField';
import type { MapRuntime } from '../world/MapRuntime';
import type { GameSettings } from './settings';

const SHADOW_MAP: Record<GameSettings['shadowQuality'], number> = { off: 512, low: 1024, medium: 2048, high: 4096 };
const FOLIAGE: Record<GameSettings['foliageQuality'], { stream: number; effects: number }> = {
  low: { stream: 0.6, effects: 0.5 },
  medium: { stream: 0.85, effects: 0.8 },
  high: { stream: 1, effects: 1 },
};

/** 依植被品質決定分塊串流距離倍率（初次載入地圖時也要使用）。 */
export function streamScaleFor(settings: GameSettings): number {
  return FOLIAGE[settings.foliageQuality].stream;
}

/** 水面倒影解析度（相對於畫面）：低畫質關閉，改用天空顏色。初次載入地圖時也要使用。 */
const REFLECTION: Record<GameSettings['foliageQuality'], number> = { low: 0, medium: 0.35, high: 0.5 };

export function reflectionScaleFor(settings: GameSettings): number {
  return REFLECTION[settings.foliageQuality];
}

/** 依植被品質決定草地範圍（初次載入地圖時也要使用）。 */
export function grassQualityFor(settings: GameSettings): GrassQuality {
  return GRASS_QUALITY[settings.foliageQuality];
}

/**
 * 畫質設定與動態解析度（主規格 §3.3）：畫格時間持續超過 20 ms 時降低渲染解析度，
 * 持續低於 13 ms 時逐步恢復，不低於設定值的 60%。
 */
export class QualityController {
  private settings: GameSettings | null = null;
  private dynamicFactor = 1;
  private accumulated = 0;
  private frames = 0;
  private window = 0;

  constructor(
    private readonly renderer: Renderer,
    private readonly map: MapRuntime,
    private readonly effects: Effects,
  ) {}

  apply(settings: GameSettings): void {
    this.settings = settings;
    if (!settings.dynamicResolution) {
      this.dynamicFactor = 1;
    }
    const shadows = settings.shadowQuality !== 'off';
    this.renderer.setShadowsEnabled(shadows);
    this.map.setQuality({ shadows, shadowMapSize: SHADOW_MAP[settings.shadowQuality], streamScale: FOLIAGE[settings.foliageQuality].stream, grass: grassQualityFor(settings), reflectionScale: reflectionScaleFor(settings) });
    this.effects.density = FOLIAGE[settings.foliageQuality].effects;
    this.renderer.setPostProcessing(settings.postProcessing);
    this.applyScale();
  }

  update(frameSeconds: number): void {
    if (!this.settings?.dynamicResolution || frameSeconds <= 0) {
      return;
    }
    this.accumulated += frameSeconds;
    this.frames++;
    this.window += frameSeconds;
    if (this.window < 1) {
      return;
    }
    const averageMs = (this.accumulated / this.frames) * 1000;
    this.accumulated = 0;
    this.frames = 0;
    this.window = 0;
    const before = this.dynamicFactor;
    if (averageMs > 20) {
      this.dynamicFactor = Math.max(0.6, this.dynamicFactor - 0.1);
    } else if (averageMs < 13) {
      this.dynamicFactor = Math.min(1, this.dynamicFactor + 0.05);
    }
    if (before !== this.dynamicFactor) {
      this.applyScale();
    }
  }

  state() {
    return {
      preset: this.settings?.graphicsPreset ?? 'medium',
      renderScale: this.renderer.currentRenderScale,
      dynamicFactor: this.dynamicFactor,
      shadows: this.settings?.shadowQuality ?? 'medium',
      postProcessing: this.settings?.postProcessing ?? false,
    };
  }

  private applyScale(): void {
    if (this.settings) {
      this.renderer.setRenderScale(this.settings.renderScale * this.dynamicFactor);
    }
  }
}
