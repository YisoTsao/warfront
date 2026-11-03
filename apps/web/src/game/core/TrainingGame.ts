import { TargetDummies } from '../combat/TargetDummies';
import type { FrontlineDebugHook } from '../debug/debugHook';
import type { MapMarker } from '../hud/TacticalMap';
import type { SimulationInput } from '../input/InputManager';
import { WeaponController } from '../weapons/WeaponController';
import { GameBase, createGameParts, type GameBaseOptions, type GameParts } from './GameBase';

export type TrainingOptions = Omit<GameBaseOptions, 'matchSeed' | 'playerNumber'>;

/** 訓練場（單機）：靶場假人，命中與傷害由前端判定。 */
export class TrainingGame extends GameBase {
  private hits = { total: 0, headshots: 0, kills: 0 };

  private constructor(
    parts: GameParts,
    private readonly dummies: TargetDummies,
  ) {
    super(parts);
    this.hud.set({ mode: 'offline', phase: 'offline', health: 100, maxHealth: 100 });
  }

  static async create(container: HTMLElement, options: TrainingOptions): Promise<TrainingGame> {
    const holder: { game: TrainingGame | null; dummies: TargetDummies | null } = { game: null, dummies: null };
    const parts = await createGameParts(container, { ...options, matchSeed: Math.floor(Math.random() * 2 ** 31), playerNumber: 0 }, (p) => {
      holder.dummies = new TargetDummies(p.renderer.scene, p.map.sim, p.map.defaultSpawn());
      return WeaponController.offlineResolver(p.map.sim, holder.dummies, (zone, killed) => holder.game?.onDummyHit(zone, killed));
    });
    const game = new TrainingGame(parts, holder.dummies!);
    holder.game = game;
    game.applySettings(options.settings);
    return game;
  }

  private onDummyHit(zone: string, killed: boolean): void {
    this.hits.total++;
    if (zone === 'head') {
      this.hits.headshots++;
    }
    if (killed) {
      this.hits.kills++;
    }
    this.showHitMarker(zone, killed);
  }

  protected simulateStep(dt: number, input: SimulationInput): void {
    this.stepLocal(dt, input, true);
    if (this.player.body.position.y < this.map.manifest.killPlaneY) {
      const spawn = this.map.defaultSpawn();
      this.player.teleport({ x: spawn.position[0], y: spawn.position[1], z: spawn.position[2] });
    }
  }

  protected onFrame(frameSeconds: number): void {
    this.dummies.update(this.simTime, frameSeconds);
  }

  protected localAlive(): boolean {
    return true;
  }

  protected mapMarkers(): MapMarker[] {
    return this.map.manifest.objectives.map((o) => ({ kind: 'objective', x: o.position[0], z: o.position[2], label: o.id, radius: o.radius, team: null }));
  }

  protected override extendDebugHook(hook: FrontlineDebugHook): void {
    hook.combat = () => ({ ...this.hits, dummiesAlive: this.dummies.aliveCount(), dummies: this.dummies.count });
  }

  protected override disposeExtras(): void {
    this.dummies.dispose();
  }
}
