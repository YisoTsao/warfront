import { LIFE_CODES, LOCOMOTION_CODES, STANCE_CODES, type RemotePlayerWire, type Stance, type TeamName } from '@frontline/shared';
import { raycastHitbox, type HitboxHit, type SimWorld } from '@frontline/simulation';
import * as THREE from 'three';
import { SoldierModel, animationFor } from '../animation/SoldierModel';
import type { AudioSystem } from '../audio/AudioSystem';
import { Footsteps } from '../player/Footsteps';

interface Sample {
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  stance: Stance;
  locomotion: (typeof LOCOMOTION_CODES)[number];
  life: (typeof LIFE_CODES)[number];
  weapon: string;
  spotted: boolean;
  connected: boolean;
}

interface Remote {
  number: number;
  team: TeamName;
  bot: boolean;
  model: SoldierModel;
  marker: THREE.Sprite | null;
  buffer: Sample[];
  rendered: Sample | null;
  footsteps: Footsteps;
  lastFeet: THREE.Vector3;
}

const MAX_EXTRAPOLATE_TICKS = 3;

/**
 * 遠端玩家：以快照插值（落後約 2 個快照）顯示位置、視角、姿勢與動畫。
 * 新快照晚到時最多外插 3 個 tick；過舊或亂序的快照直接忽略。
 */
export class RemotePlayers {
  private readonly remotes = new Map<number, Remote>();
  private readonly group = new THREE.Group();
  private readonly markerMaterials: Record<TeamName, THREE.SpriteMaterial>;
  private readonly temp = new THREE.Vector3();
  myTeam: TeamName | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sim: SimWorld,
    private readonly audio: AudioSystem,
  ) {
    this.group.name = 'remote-players';
    scene.add(this.group);
    const markerTexture = (color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(4, 6);
      ctx.lineTo(28, 6);
      ctx.lineTo(16, 26);
      ctx.closePath();
      ctx.fill();
      return new THREE.CanvasTexture(canvas);
    };
    this.markerMaterials = {
      alpha: new THREE.SpriteMaterial({ map: markerTexture('#6aa8ff'), depthTest: false, transparent: true }),
      bravo: new THREE.SpriteMaterial({ map: markerTexture('#ff8a66'), depthTest: false, transparent: true }),
    };
  }

  /** 收到快照：加入每位玩家的緩衝區，移除已經不在快照裡的玩家。 */
  ingest(tick: number, players: RemotePlayerWire[]): void {
    const seen = new Set<number>();
    for (const wire of players) {
      const [number, x, y, z, yaw, pitch, stance, loc, life, team, weapon, flags] = wire;
      seen.add(number);
      const teamName: TeamName = team === 0 ? 'alpha' : 'bravo';
      let remote = this.remotes.get(number);
      if (!remote || remote.team !== teamName) {
        if (remote) {
          this.remove(number);
        }
        const model = new SoldierModel(teamName, `remote-${number}`);
        this.group.add(model.root);
        remote = { number, team: teamName, bot: (flags & 4) !== 0, model, marker: null, buffer: [], rendered: null, footsteps: new Footsteps(this.sim), lastFeet: new THREE.Vector3(x, y, z) };
        this.remotes.set(number, remote);
      }
      const last = remote.buffer[remote.buffer.length - 1];
      if (last && tick <= last.tick) {
        continue;
      }
      remote.buffer.push({
        tick,
        x,
        y,
        z,
        yaw,
        pitch,
        stance: STANCE_CODES[stance] ?? 'standing',
        locomotion: LOCOMOTION_CODES[loc] ?? 'idle',
        life: LIFE_CODES[life] ?? 'alive',
        weapon,
        spotted: (flags & 1) !== 0,
        connected: (flags & 2) === 0,
      });
      if (remote.buffer.length > 40) {
        remote.buffer.shift();
      }
    }
    for (const number of this.remotes.keys()) {
      if (!seen.has(number)) {
        this.remove(number);
      }
    }
  }

  update(renderTick: number, frameSeconds: number, listenerPosition: THREE.Vector3): void {
    for (const remote of this.remotes.values()) {
      const sample = this.sample(remote, renderTick);
      remote.rendered = sample;
      const visible = sample !== null && sample.life !== 'spectating' && sample.connected;
      remote.model.root.visible = visible;
      if (!sample || !visible) {
        continue;
      }
      remote.model.root.position.set(sample.x, sample.y, sample.z);
      remote.model.root.rotation.y = sample.yaw;
      remote.model.play(animationFor(sample.stance, sample.locomotion, sample.life === 'dead' ? 'dead' : sample.life === 'downed' ? 'downed' : 'alive'));
      remote.model.update(frameSeconds, sample.life === 'alive' ? sample.pitch : 0);
      const friendly = this.myTeam !== null && remote.team === this.myTeam;
      remote.model.setSpotted(!friendly && sample.spotted);
      this.updateMarker(remote, friendly && sample.life !== 'dead');
      // 遠端腳步聲（空間化）
      this.temp.set(sample.x, sample.y, sample.z);
      if (this.temp.distanceTo(listenerPosition) < 40) {
        const step = remote.footsteps.step(this.temp, remote.lastFeet, sample.locomotion, sample.stance, sample.locomotion !== 'airborne');
        if (step) {
          this.audio.footstep(this.temp, step.surface, step.loudness);
        }
      }
      remote.lastFeet.copy(this.temp);
    }
  }

  private updateMarker(remote: Remote, show: boolean): void {
    if (show && !remote.marker) {
      remote.marker = new THREE.Sprite(this.markerMaterials[remote.team]);
      remote.marker.scale.set(0.35, 0.35, 0.35);
      remote.marker.position.set(0, 2.25, 0);
      remote.marker.renderOrder = 10;
      remote.model.root.add(remote.marker);
    }
    if (remote.marker) {
      remote.marker.visible = show;
    }
  }

  private sample(remote: Remote, renderTick: number): Sample | null {
    const buffer = remote.buffer;
    if (buffer.length === 0) {
      return null;
    }
    // 丟掉已經用不到的舊快照（保留一筆在 renderTick 之前）
    while (buffer.length > 2 && buffer[1]!.tick <= renderTick) {
      buffer.shift();
    }
    const a = buffer[0]!;
    const b = buffer[1];
    if (!b || renderTick <= a.tick) {
      if (!b && renderTick > a.tick && buffer.length >= 1) {
        return a;
      }
      return a;
    }
    if (renderTick > b.tick) {
      // 外插（有上限）
      const ahead = Math.min(MAX_EXTRAPOLATE_TICKS, renderTick - b.tick) / Math.max(1, b.tick - a.tick);
      return { ...b, x: b.x + (b.x - a.x) * ahead, y: b.y + (b.y - a.y) * ahead, z: b.z + (b.z - a.z) * ahead };
    }
    const t = (renderTick - a.tick) / Math.max(1e-6, b.tick - a.tick);
    // 剛重生（位置跳很遠）時不要內插
    if (Math.hypot(b.x - a.x, b.z - a.z) > 8) {
      return t < 0.5 ? a : b;
    }
    const yaw = a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * t;
    return {
      ...(t < 0.5 ? a : b),
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      yaw,
      pitch: a.pitch + (b.pitch - a.pitch) * t,
    };
  }

  /** 遠端玩家的槍口位置（顯示他人開火特效用）。 */
  muzzleOf(number: number, target: THREE.Vector3): THREE.Vector3 | null {
    const remote = this.remotes.get(number);
    if (!remote?.model.root.visible) {
      return null;
    }
    remote.model.root.updateWorldMatrix(true, true);
    return remote.model.muzzle.getWorldPosition(target);
  }

  /** 預測命中（只用來提早顯示血霧，傷害以伺服器為準）。 */
  raycast(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDistance: number, excludeTeam: TeamName | null): (HitboxHit & { number: number }) | null {
    let best: (HitboxHit & { number: number }) | null = null;
    for (const remote of this.remotes.values()) {
      const s = remote.rendered;
      if (!s || s.life !== 'alive' || (excludeTeam && remote.team === excludeTeam)) {
        continue;
      }
      const hit = raycastHitbox({ feet: { x: s.x, y: s.y, z: s.z }, yaw: s.yaw, stance: s.stance }, origin, dir, maxDistance);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { ...hit, number: remote.number };
      }
    }
    return best;
  }

  positions(): Array<{ number: number; team: TeamName; x: number; z: number; yaw: number; alive: boolean; spotted: boolean }> {
    return [...this.remotes.values()]
      .filter((r) => r.rendered)
      .map((r) => ({ number: r.number, team: r.team, x: r.rendered!.x, z: r.rendered!.z, yaw: r.rendered!.yaw, alive: r.rendered!.life === 'alive', spotted: r.rendered!.spotted }));
  }

  get count(): number {
    return this.remotes.size;
  }

  private remove(number: number): void {
    const remote = this.remotes.get(number);
    if (remote) {
      remote.model.dispose();
      this.remotes.delete(number);
    }
  }

  dispose(): void {
    for (const number of [...this.remotes.keys()]) {
      this.remove(number);
    }
    this.group.removeFromParent();
    for (const m of Object.values(this.markerMaterials)) {
      m.map?.dispose();
      m.dispose();
    }
  }
}
