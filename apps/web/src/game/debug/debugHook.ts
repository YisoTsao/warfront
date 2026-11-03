import type { CharacterSnapshot } from '@frontline/simulation';
import type { StreamingStats } from '../world/ChunkStreamer';
import type { FrameStats } from './DebugStats';

/** 一個模擬步驟的紀錄。測試以模擬步驟（固定 1/60 秒）判斷，不受渲染 FPS 影響。 */
export interface StepSample {
  step: number;
  x: number;
  y: number;
  z: number;
  speed: number;
  vy: number;
  grounded: boolean;
  stance: string;
}

/** 開發與自動化測試用的唯讀狀態與少數操作。正式版只有加上 ?debug 才會掛上。 */
export interface FrontlineDebugHook {
  snapshot(): CharacterSnapshot & {
    yaw: number;
    pitch: number;
    pointerLocked: boolean;
    stats: FrameStats;
    mapId: string;
    streaming: StreamingStats | null;
  };
  /** 注入滑鼠位移（像素），等同於 Pointer Lock 下移動滑鼠 */
  look(dxPixels: number, dyPixels: number): void;
  /** 把玩家放到指定腳底位置 */
  teleport(x: number, y: number, z: number): void;
  /** 直接設定視角（弧度） */
  setView(yaw: number, pitch: number): void;
  /** 開始記錄每個模擬步驟 */
  startRecording(): void;
  /** 目前已記錄的步數（不停止記錄） */
  recordedStepCount(): number;
  /** 停止記錄並取回紀錄 */
  stopRecording(): StepSample[];
  /** 模擬頻率（每秒步數） */
  tickRate: number;
  /** 地面高度（從上方往下打射線），找不到時回傳 null */
  groundHeight(x: number, z: number): number | null;
  /** 場景中的網格數量（檢查 instancing 與串流用） */
  sceneInfo(): { meshes: number; instancedMeshes: number; instances: number };
}

declare global {
  interface Window {
    __frontline?: FrontlineDebugHook;
  }
}

export function debugHookEnabled(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }
  try {
    return new URLSearchParams(window.location.search).has('debug');
  } catch {
    return false;
  }
}
