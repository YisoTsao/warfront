/**
 * 伺服器指標（主規格 §15.2）：房間 tick 耗時與漂移、CPU／記憶體、房間與連線數、
 * 收發訊息量、延遲、快照大小、驗證拒絕與可疑輸入、對戰完成與錯誤。
 * 以 /metrics 提供 JSON 與 Prometheus 文字格式。
 */
export interface RoomMetrics {
  roomId: string;
  mode: string;
  mapId: string;
  humans: number;
  bots: number;
  tickMs: number[];
  driftMs: number[];
  snapshotBytes: number[];
  messagesIn: number;
  messagesOut: number;
  bytesOut: number;
  rejected: number;
  rateLimited: number;
  suspicious: number;
  pings: number[];
}

const startedAt = Date.now();
const rooms = new Map<string, RoomMetrics>();
const totals = {
  connections: 0,
  disconnects: 0,
  reconnects: 0,
  matchesCompleted: 0,
  roomErrors: 0,
  joinsRejected: 0,
  clientErrors: 0,
};

const WINDOW = 300;

function push(list: number[], value: number): void {
  list.push(value);
  if (list.length > WINDOW) {
    list.shift();
  }
}

export const metrics = {
  room(roomId: string, mode: string, mapId: string): RoomMetrics {
    let m = rooms.get(roomId);
    if (!m) {
      m = { roomId, mode, mapId, humans: 0, bots: 0, tickMs: [], driftMs: [], snapshotBytes: [], messagesIn: 0, messagesOut: 0, bytesOut: 0, rejected: 0, rateLimited: 0, suspicious: 0, pings: [] };
      rooms.set(roomId, m);
    }
    return m;
  },
  tick(m: RoomMetrics, ms: number, drift: number): void {
    push(m.tickMs, ms);
    push(m.driftMs, drift);
  },
  snapshot(m: RoomMetrics, bytes: number): void {
    push(m.snapshotBytes, bytes);
    m.messagesOut++;
    m.bytesOut += bytes;
  },
  ping(m: RoomMetrics, ms: number): void {
    push(m.pings, ms);
  },
  removeRoom(roomId: string): void {
    rooms.delete(roomId);
  },
  count(key: keyof typeof totals, amount = 1): void {
    totals[key] += amount;
  },
  report() {
    const stats = (values: number[]) => {
      if (values.length === 0) {
        return { avg: 0, p95: 0, max: 0 };
      }
      const sorted = [...values].sort((a, b) => a - b);
      return {
        avg: Math.round((sorted.reduce((s, v) => s + v, 0) / sorted.length) * 100) / 100,
        p95: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! * 100) / 100,
        max: Math.round(sorted[sorted.length - 1]! * 100) / 100,
      };
    };
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      process: {
        rssMb: Math.round(memory.rss / 1048576),
        heapUsedMb: Math.round(memory.heapUsed / 1048576),
        cpuUserSeconds: Math.round(cpu.user / 1e6),
        cpuSystemSeconds: Math.round(cpu.system / 1e6),
      },
      totals: { ...totals, activeRooms: rooms.size },
      rooms: [...rooms.values()].map((m) => ({
        roomId: m.roomId,
        mode: m.mode,
        mapId: m.mapId,
        humans: m.humans,
        bots: m.bots,
        tickMs: stats(m.tickMs),
        tickDriftMs: stats(m.driftMs),
        snapshotBytes: stats(m.snapshotBytes),
        pingMs: stats(m.pings),
        messagesIn: m.messagesIn,
        messagesOut: m.messagesOut,
        bytesOut: m.bytesOut,
        rejectedInputs: m.rejected,
        rateLimited: m.rateLimited,
        suspicious: m.suspicious,
      })),
    };
  },
  prometheus(): string {
    const r = metrics.report();
    const lines = [
      `frontline_uptime_seconds ${r.uptimeSeconds}`,
      `frontline_rss_megabytes ${r.process.rssMb}`,
      `frontline_active_rooms ${r.totals.activeRooms}`,
      `frontline_connections_total ${r.totals.connections}`,
      `frontline_disconnects_total ${r.totals.disconnects}`,
      `frontline_matches_completed_total ${r.totals.matchesCompleted}`,
      `frontline_room_errors_total ${r.totals.roomErrors}`,
      `frontline_client_errors_total ${r.totals.clientErrors}`,
    ];
    for (const room of r.rooms) {
      const labels = `{room="${room.roomId}",mode="${room.mode}",map="${room.mapId}"}`;
      lines.push(
        `frontline_room_players${labels} ${room.humans + room.bots}`,
        `frontline_room_tick_ms_p95${labels} ${room.tickMs.p95}`,
        `frontline_room_snapshot_bytes_avg${labels} ${room.snapshotBytes.avg}`,
        `frontline_room_rejected_inputs_total${labels} ${room.rejectedInputs}`,
      );
    }
    return `${lines.join('\n')}\n`;
  },
};
