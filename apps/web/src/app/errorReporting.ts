import { gameServerHttpUrl } from '../game/network/GameTransport';

const MAX_REPORTS_PER_MINUTE = 5;
let sent: number[] = [];

/**
 * 客戶端當機回報：把未處理的例外送到對戰伺服器的 /client-errors（sendBeacon，不阻塞畫面）。
 * 只送錯誤訊息、堆疊與瀏覽器資訊，不含任何玩家輸入或個人資料。
 */
function report(message: string, stack?: string): void {
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= MAX_REPORTS_PER_MINUTE) {
    return;
  }
  sent.push(now);
  const body = JSON.stringify({
    message: message.slice(0, 500),
    stack: stack?.slice(0, 2000),
    url: window.location.pathname,
    userAgent: navigator.userAgent,
    build: import.meta.env.MODE,
  });
  try {
    navigator.sendBeacon(`${gameServerHttpUrl()}/client-errors`, new Blob([body], { type: 'text/plain' }));
  } catch {
    // 回報失敗不影響遊戲
  }
}

export function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    report(event.message, event.error instanceof Error ? event.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    report(reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : undefined);
  });
}
