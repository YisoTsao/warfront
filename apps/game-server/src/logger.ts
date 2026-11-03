/** 結構化日誌：每行一個 JSON，方便集中收集與查詢。 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minimum = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < minimum) {
    return;
  }
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}
