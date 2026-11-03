import { useEffect, useState } from 'react';
import { gameServerHttpUrl } from '../game/network/GameTransport';

interface RoomInfo {
  roomId: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  metadata?: { mode?: 'tdm' | 'conquest'; mapId?: string; mapName?: string; humans?: number; bots?: number; phase?: string };
}

interface ServerListProps {
  onJoin(room: { roomId: string; mode: 'tdm' | 'conquest'; mapId?: string }): void;
  onBack(): void;
}

/** 伺服器列表：每 3 秒更新一次目前的對戰房間。 */
export function ServerList({ onJoin, onBack }: ServerListProps) {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${gameServerHttpUrl()}/rooms`);
        const data = (await response.json()) as RoomInfo[];
        if (!cancelled) {
          setRooms(data);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(`無法連線到對戰伺服器（${gameServerHttpUrl()}）`);
        }
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="overlay overlay--solid">
      <div className="panel panel--wide">
        <h1 className="title">伺服器列表</h1>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {rooms && rooms.length === 0 && <p className="muted">目前沒有進行中的對戰，可以從主選單開始快速對戰。</p>}
        {rooms && rooms.length > 0 && (
          <table className="server-list">
            <thead>
              <tr>
                <th>地圖</th>
                <th>模式</th>
                <th>人數</th>
                <th>狀態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.roomId}>
                  <td>{r.metadata?.mapName ?? r.metadata?.mapId ?? '—'}</td>
                  <td>{r.metadata?.mode === 'conquest' ? '征服' : '團隊死鬥'}</td>
                  <td>
                    {r.metadata?.humans ?? r.clients} 人 + {r.metadata?.bots ?? 0} bot / {r.maxClients}
                  </td>
                  <td>{r.metadata?.phase === 'ended' ? '結算中' : r.metadata?.phase === 'warmup' ? '暖身' : '進行中'}</td>
                  <td>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={r.locked || r.clients >= r.maxClients}
                      onClick={() => onJoin({ roomId: r.roomId, mode: r.metadata?.mode ?? 'tdm', ...(r.metadata?.mapId ? { mapId: r.metadata.mapId } : {}) })}
                    >
                      加入
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button type="button" className="button" onClick={onBack}>
          返回
        </button>
      </div>
    </div>
  );
}
