import type { Locomotion, Stance, Vec3 } from '@frontline/shared';
import { waterDepthAt, type SimWorld } from '@frontline/simulation';

const STRIDE: Record<string, number> = { walking: 1.5, sprinting: 2.1, crouching: 1.1 };

/** 依移動距離與地面材質產生腳步聲事件（本機與遠端玩家共用）。 */
export class Footsteps {
  private travelled = 0;

  constructor(private readonly sim: SimWorld) {}

  /** 回傳這一步要播的腳步聲（材質），沒有則為 null。 */
  step(feet: Vec3, previous: Vec3, locomotion: Locomotion, stance: Stance, grounded: boolean): { surface: string; loudness: number } | null {
    if (!grounded || stance === 'prone' || locomotion === 'idle' || locomotion === 'airborne') {
      return null;
    }
    this.travelled += Math.hypot(feet.x - previous.x, feet.z - previous.z);
    const stride = stance === 'crouching' ? STRIDE.crouching! : locomotion === 'sprinting' ? STRIDE.sprinting! : STRIDE.walking!;
    if (this.travelled < stride / 2) {
      return null;
    }
    this.travelled = 0;
    const depth = waterDepthAt(this.sim.manifest, feet);
    if (depth !== 'none') {
      return { surface: 'water', loudness: 1 };
    }
    const hit = this.sim.castBullet({ x: feet.x, y: feet.y + 0.4, z: feet.z }, { x: 0, y: -1, z: 0 }, 1);
    const loudness = stance === 'crouching' ? 0.35 : locomotion === 'sprinting' ? 1.2 : 0.7;
    return { surface: hit?.material ?? 'dirt', loudness };
  }
}
