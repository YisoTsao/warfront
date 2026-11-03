export interface CompatibilityReport {
  supported: boolean;
  webgl2: boolean;
  webAssembly: boolean;
  pointerLock: boolean;
  /** 不支援時給玩家看的原因 */
  problems: string[];
}

function detectWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    // 立即釋放測試用的 context，避免占用瀏覽器的 context 數量上限。
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/** 啟動前檢查必要的瀏覽器功能。 */
export function checkCompatibility(): CompatibilityReport {
  const problems: string[] = [];

  const webgl2 = detectWebGL2();
  if (!webgl2) {
    problems.push('瀏覽器或顯示卡不支援 WebGL 2。請更新瀏覽器、啟用硬體加速，或改用最新版 Chrome / Edge。');
  }

  const webAssembly = typeof WebAssembly === 'object';
  if (!webAssembly) {
    problems.push('瀏覽器不支援 WebAssembly，無法執行物理引擎。');
  }

  const pointerLock = 'requestPointerLock' in Element.prototype;
  if (!pointerLock) {
    problems.push('瀏覽器不支援 Pointer Lock，無法用滑鼠控制視角。');
  }

  return { supported: problems.length === 0, webgl2, webAssembly, pointerLock, problems };
}
