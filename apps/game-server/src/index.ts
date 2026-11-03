import { createServer } from 'node:http';
import { Server, createEndpoint, createRouter, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { config } from './config';
import { log } from './logger';
import { metrics } from './metrics';
import { MatchRoom } from './room/MatchRoom';
import { JoinLimiter } from './room/RateLimiter';

/**
 * FRONTLINE 對戰伺服器：Colyseus 權威房間 + 健康檢查、指標與房間列表端點。
 * 必須以常駐程序（或容器）執行，不能是 serverless function。
 */

function json(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) } });
}

const health = createEndpoint('/health', { method: 'GET' }, async () => json({ status: 'ok' }));

const metricsEndpoint = createEndpoint('/metrics', { method: 'GET' }, async (ctx) => {
  const url = new URL(ctx.request?.url ?? '/metrics', 'http://localhost');
  if (url.searchParams.get('format') === 'prometheus') {
    return new Response(metrics.prometheus(), { headers: { 'content-type': 'text/plain; version=0.0.4' } });
  }
  return json(metrics.report());
});

/** 伺服器列表：目前所有對戰房間（瀏覽器的「伺服器列表」畫面使用）。 */
const roomsEndpoint = createEndpoint('/rooms', { method: 'GET' }, async () => {
  const rooms = await matchMaker.query({ name: 'match' });
  return json(rooms.map((r) => ({ roomId: r.roomId, clients: r.clients, maxClients: r.maxClients, locked: r.locked, metadata: r.metadata })));
});

/**
 * 客戶端錯誤回報（瀏覽器的未處理例外）：記錄後供除錯與告警使用。
 * 只接受小型 JSON，並以每個來源 IP 限流。
 */
const clientErrorLimiter = new JoinLimiter(20, 60_000);
const clientErrors = createEndpoint('/client-errors', { method: 'POST' }, async (ctx) => {
  const ip = ctx.request?.headers.get('x-forwarded-for') ?? 'unknown';
  if (!clientErrorLimiter.allow(ip)) {
    return json({ ok: false }, 429);
  }
  let body: unknown = ctx.body;
  if (typeof body === 'string') {
    const raw = body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { message: raw.slice(0, 500) };
    }
  }
  const report = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  metrics.count('clientErrors');
  log('warn', 'client_error', {
    message: text(report.message, 500),
    stack: text(report.stack, 2000),
    url: text(report.url, 300),
    userAgent: text(report.userAgent, 300),
    build: text(report.build, 64),
  });
  return json({ ok: true });
});

const transport = new WebSocketTransport({ server: createServer(), maxPayload: 16 * 1024 });
const gameServer = new Server({ transport, gracefullyShutdown: true });
gameServer.router = createRouter({ health, metricsEndpoint, roomsEndpoint, clientErrors }, { openapi: { disabled: true } });
gameServer.define('match', MatchRoom).filterBy(['mode', 'mapId']);

await gameServer.listen(config.port, config.host);
log('info', 'server_listening', { port: config.port, mapsDir: config.mapsDir, defaultMap: config.defaultMap, botFill: config.defaultBotFill });
