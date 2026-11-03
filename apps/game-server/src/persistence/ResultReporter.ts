import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../logger';

export interface MatchRecord {
  matchId: string;
  roomId: string;
  mapId: string;
  mode: string;
  endedAt: string;
  durationSeconds: number;
  winner: string;
  scores: { alpha: number; bravo: number };
  players: Array<{ guestId: string; name: string; team: string; bot: boolean; kills: number; deaths: number; assists: number; score: number }>;
}

/**
 * 對戰結束時，由伺服器回報經過驗證的結果（客戶端不能提交自己的分數）。
 * 現階段沒有帳號系統，先寫入 JSONL 檔；之後接 Supabase 時替換這個實作即可。
 */
export interface ResultReporter {
  report(record: MatchRecord): Promise<void>;
}

export class JsonlResultReporter implements ResultReporter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  async report(record: MatchRecord): Promise<void> {
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
      log('info', 'match_result_recorded', { matchId: record.matchId, winner: record.winner });
    } catch (error) {
      log('error', 'match_result_write_failed', { error: String(error) });
    }
  }
}
