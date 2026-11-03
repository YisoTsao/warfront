import type { ConquestConfig, GameModeConfig, TeamDeathmatchConfig } from '@frontline/game-config';
import type { Objective } from '@frontline/map-schema';
import type { ObjectiveWire, TeamName, Vec3 } from '@frontline/shared';

export interface ObjectiveState extends ObjectiveWire {
  /** 本 tick 內在範圍裡的人數 */
  alphaInside: number;
  bravoInside: number;
}

export interface ModeTickInput {
  dt: number;
  /** 存活（未倒地）玩家的位置與隊伍 */
  occupants: Array<{ number: number; team: TeamName; feet: Vec3 }>;
}

export interface ModeTickResult {
  captured: Array<{ id: string; team: TeamName | null; capturers: number[] }>;
}

export const otherTeam = (team: TeamName): TeamName => (team === 'alpha' ? 'bravo' : 'alpha');

/** 模式規則的共同介面：計分、勝負與據點。玩家控制器內不放任何模式專屬邏輯。 */
export interface ModeRules {
  readonly config: GameModeConfig;
  scores(): { alpha: number; bravo: number };
  scoreLimit(): number;
  objectives(): ObjectiveState[];
  /** 有玩家陣亡（真正死亡，不含倒地） */
  onDeath(team: TeamName): void;
  /** 計入擊殺（擊殺者所屬隊伍） */
  onKill(killerTeam: TeamName | null, victimTeam: TeamName): void;
  tick(input: ModeTickInput): ModeTickResult;
  /** 勝負已分：回傳勝方或平手；未分出回傳 null */
  winner(timeUp: boolean): TeamName | 'draw' | null;
  reset(): void;
}

export class TeamDeathmatch implements ModeRules {
  private score = { alpha: 0, bravo: 0 };

  constructor(readonly config: TeamDeathmatchConfig) {}

  scores() {
    return { ...this.score };
  }

  scoreLimit() {
    return this.config.scoreLimit;
  }

  objectives(): ObjectiveState[] {
    return [];
  }

  onDeath(): void {}

  onKill(killerTeam: TeamName | null, victimTeam: TeamName): void {
    // 自殺或誤殺隊友不給分
    if (killerTeam && killerTeam !== victimTeam) {
      this.score[killerTeam]++;
    }
  }

  tick(): ModeTickResult {
    return { captured: [] };
  }

  winner(timeUp: boolean): TeamName | 'draw' | null {
    if (this.score.alpha >= this.config.scoreLimit) {
      return 'alpha';
    }
    if (this.score.bravo >= this.config.scoreLimit) {
      return 'bravo';
    }
    if (timeUp) {
      return this.score.alpha === this.score.bravo ? 'draw' : this.score.alpha > this.score.bravo ? 'alpha' : 'bravo';
    }
    return null;
  }

  reset(): void {
    this.score = { alpha: 0, bravo: 0 };
  }
}

/** 征服：佔領據點、票數、擁有多數據點時對方流失票數。 */
export class Conquest implements ModeRules {
  private tickets: { alpha: number; bravo: number };
  private state: ObjectiveState[];

  constructor(
    readonly config: ConquestConfig,
    private readonly mapObjectives: readonly Objective[],
  ) {
    this.tickets = { alpha: config.startingTickets, bravo: config.startingTickets };
    this.state = this.initialObjectives();
  }

  private initialObjectives(): ObjectiveState[] {
    return this.mapObjectives.map((o) => ({
      id: o.id,
      name: o.name,
      owner: o.initialOwner ?? null,
      progress: o.initialOwner === 'alpha' ? 1 : o.initialOwner === 'bravo' ? -1 : 0,
      contested: false,
      position: [...o.position],
      radius: o.radius,
      alphaInside: 0,
      bravoInside: 0,
    }));
  }

  scores() {
    return { alpha: Math.max(0, this.tickets.alpha), bravo: Math.max(0, this.tickets.bravo) };
  }

  scoreLimit() {
    return this.config.startingTickets;
  }

  objectives(): ObjectiveState[] {
    return this.state;
  }

  onDeath(team: TeamName): void {
    this.tickets[team] -= this.config.ticketsPerDeath;
  }

  onKill(): void {}

  tick({ dt, occupants }: ModeTickInput): ModeTickResult {
    const captured: ModeTickResult['captured'] = [];
    for (const o of this.state) {
      const inside = occupants.filter(
        (p) => Math.hypot(p.feet.x - o.position[0], p.feet.z - o.position[2]) <= o.radius && Math.abs(p.feet.y - o.position[1]) < 8,
      );
      o.alphaInside = inside.filter((p) => p.team === 'alpha').length;
      o.bravoInside = inside.filter((p) => p.team === 'bravo').length;
      o.contested = o.alphaInside > 0 && o.bravoInside > 0;
      if (o.contested || (o.alphaInside === 0 && o.bravoInside === 0)) {
        continue;
      }
      const team: TeamName = o.alphaInside > 0 ? 'alpha' : 'bravo';
      const count = team === 'alpha' ? o.alphaInside : o.bravoInside;
      const rate = (Math.min(count, this.config.maxCaptureMultiplier) / this.config.captureSeconds) * dt;
      const before = o.progress;
      const direction = team === 'alpha' ? 1 : -1;
      o.progress = Math.max(-1, Math.min(1, o.progress + direction * rate));
      // 越過中線：原擁有者失去據點
      if (o.owner && o.owner !== team && Math.sign(o.progress) !== Math.sign(before) && o.progress !== before) {
        o.owner = null;
        captured.push({ id: o.id, team: null, capturers: inside.filter((p) => p.team === team).map((p) => p.number) });
      }
      if (Math.abs(o.progress) >= 1 && o.owner !== team) {
        o.owner = team;
        captured.push({ id: o.id, team, capturers: inside.filter((p) => p.team === team).map((p) => p.number) });
      }
    }
    // 擁有多數據點的一方讓對方流失票數
    const alphaOwned = this.state.filter((o) => o.owner === 'alpha').length;
    const bravoOwned = this.state.filter((o) => o.owner === 'bravo').length;
    if (alphaOwned > bravoOwned) {
      this.tickets.bravo -= this.config.bleedPerSecond * (alphaOwned - bravoOwned) * dt;
    } else if (bravoOwned > alphaOwned) {
      this.tickets.alpha -= this.config.bleedPerSecond * (bravoOwned - alphaOwned) * dt;
    }
    return { captured };
  }

  winner(timeUp: boolean): TeamName | 'draw' | null {
    if (this.tickets.alpha <= 0 && this.tickets.bravo <= 0) {
      return 'draw';
    }
    if (this.tickets.alpha <= 0) {
      return 'bravo';
    }
    if (this.tickets.bravo <= 0) {
      return 'alpha';
    }
    if (timeUp) {
      const a = Math.round(this.tickets.alpha);
      const b = Math.round(this.tickets.bravo);
      return a === b ? 'draw' : a > b ? 'alpha' : 'bravo';
    }
    return null;
  }

  reset(): void {
    this.tickets = { alpha: this.config.startingTickets, bravo: this.config.startingTickets };
    this.state = this.initialObjectives();
  }
}

export function createMode(config: GameModeConfig, objectives: readonly Objective[]): ModeRules {
  return config.id === 'conquest' ? new Conquest(config, objectives) : new TeamDeathmatch(config);
}
