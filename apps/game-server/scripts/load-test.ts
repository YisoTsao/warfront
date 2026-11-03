/**
 * 負載測試：以 16 個真實的 Colyseus 客戶端（不是 bot）加入同一場，
 * 每個 tick 送出隨機移動與開火的輸入，量測伺服器 tick 時間、快照大小與客戶端收到的快照頻率。
 *
 *   bun run load-test -- --url ws://127.0.0.1:2567 --clients 16 --seconds 60 --map graybox
 */
import { parseArgs } from 'node:util';
import { Client, type Room } from '@colyseus/sdk';
import { BUTTON, MSG, TICK_RATE, type InputFrame } from '@frontline/shared';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:2567' },
    clients: { type: 'string', default: '16' },
    seconds: { type: 'string', default: '60' },
    map: { type: 'string', default: 'graybox' },
    mode: { type: 'string', default: 'tdm' },
  },
});

const url = values.url!;
const count = Number(values.clients);
const seconds = Number(values.seconds);
const httpUrl = url.replace(/^ws/, 'http');

interface Bot {
  room: Room;
  seq: number;
  snapshots: number;
  yaw: number;
  turn: number;
  bytes: number;
}

const bots: Bot[] = [];
const options = (i: number) => ({
  mode: values.mode,
  mapId: values.map,
  bots: 0,
  name: `load-${i}`,
  guestId: `loadtest-${Date.now().toString(36)}-${i}`,
  scoreLimit: 500,
  timeLimit: 3600,
});

console.log(`連線 ${count} 個客戶端到 ${url}…`);
const client = new Client(url);
const first = await client.joinOrCreate('match', options(0));
const roomId = first.roomId;
const rooms: Room[] = [first];
for (let i = 1; i < count; i++) {
  rooms.push(await new Client(url).joinById(roomId, options(i)));
}
for (const room of rooms) {
  const bot: Bot = { room, seq: 0, snapshots: 0, yaw: Math.random() * Math.PI * 2, turn: 0, bytes: 0 };
  room.onMessage(MSG.snapshot, (s: unknown) => {
    bot.snapshots++;
    bot.bytes += JSON.stringify(s).length;
  });
  for (const type of [MSG.welcome, MSG.events, MSG.match, MSG.pong, MSG.error]) {
    room.onMessage(type, () => undefined);
  }
  room.send(MSG.deploy, { spawn: 'base' });
  bots.push(bot);
}

const started = Date.now();
const timer = setInterval(() => {
  for (const bot of bots) {
    bot.seq++;
    if (Math.random() < 0.02) {
      bot.turn = (Math.random() - 0.5) * 2;
    }
    bot.yaw += bot.turn / TICK_RATE;
    const frame: InputFrame = {
      s: bot.seq,
      f: 1,
      r: Math.random() < 0.1 ? 1 : 0,
      b: (Math.random() < 0.3 ? BUTTON.fire : 0) | (Math.random() < 0.01 ? BUTTON.jump : 0) | (Math.random() < 0.5 ? BUTTON.sprint : 0),
      st: 0,
      y: bot.yaw,
      p: 0,
      w: 0,
      vt: 0,
    };
    bot.room.send(MSG.input, { frames: [frame] });
  }
}, 1000 / TICK_RATE);

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(timer);
const elapsed = (Date.now() - started) / 1000;
const metrics = (await (await fetch(`${httpUrl}/metrics`)).json()) as {
  process: Record<string, number>;
  rooms: Array<{ roomId: string; humans: number; bots: number; tickMs: Record<string, number>; tickDriftMs: Record<string, number>; snapshotBytes: Record<string, number>; rejectedInputs: number; rateLimited: number }>;
};
const room = metrics.rooms.find((r) => r.roomId === roomId);
const snapRate = bots.reduce((s, b) => s + b.snapshots, 0) / bots.length / elapsed;
const downKbps = bots.reduce((s, b) => s + b.bytes, 0) / bots.length / elapsed / 1024;

console.log('\n==== 負載測試結果 ====');
console.log(`客戶端：${count}，時間：${elapsed.toFixed(0)} 秒，房間：${roomId}（真人 ${room?.humans}、bot ${room?.bots}）`);
console.log(`伺服器 tick：平均 ${room?.tickMs.avg} ms、p95 ${room?.tickMs.p95} ms、最大 ${room?.tickMs.max} ms（預算 ${(1000 / TICK_RATE).toFixed(1)} ms）`);
console.log(`tick 漂移：平均 ${room?.tickDriftMs.avg} ms、p95 ${room?.tickDriftMs.p95} ms`);
console.log(`快照大小：平均 ${room?.snapshotBytes.avg} bytes（JSON 估算；實際以 msgpack 傳送較小）`);
console.log(`每位客戶端收到快照：${snapRate.toFixed(1)} 次／秒，下行約 ${downKbps.toFixed(1)} KB/s（JSON 估算）`);
console.log(`被拒絕的輸入：${room?.rejectedInputs}，被限流：${room?.rateLimited}`);
console.log(`伺服器程序：RSS ${metrics.process.rssMb} MB、heap ${metrics.process.heapUsedMb} MB`);

for (const r of rooms) {
  await r.leave(true).catch(() => undefined);
}
process.exit(0);
