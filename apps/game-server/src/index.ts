import { createServer } from 'node:http';
import { Server, createEndpoint, createRouter, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { config } from './config';
import { log } from './logger';
import { metrics } from './metrics';
import { MatchRoom } from './room/MatchRoom';

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

const transport = new WebSocketTransport({ server: createServer(), maxPayload: 16 * 1024 });
const gameServer = new Server({ transport, gracefullyShutdown: true });
gameServer.router = createRouter({ health, metricsEndpoint, roomsEndpoint }, { openapi: { disabled: true } });
gameServer.define('match', MatchRoom).filterBy(['mode', 'mapId']);

await gameServer.listen(config.port, config.host);
log('info', 'server_listening', { port: config.port, mapsDir: config.mapsDir, defaultMap: config.defaultMap, botFill: config.defaultBotFill });
