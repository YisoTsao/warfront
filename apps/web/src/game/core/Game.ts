import { DEFAULT_CLASS_ID, sanitizeLoadout, type Loadout } from '@frontline/game-config';
import { TICK_RATE } from '@frontline/shared';
import { initPhysics } from '@frontline/simulation';
import * as THREE from 'three';
import { AudioSystem } from '../audio/AudioSystem';
import { TargetDummies } from '../combat/TargetDummies';
import { DebugStats } from '../debug/DebugStats';
import { debugHookEnabled, type StepSample } from '../debug/debugHook';
import { HudStore } from '../hud/HudStore';
import { InputManager } from '../input/InputManager';
import type { KeyBindings } from '../input/keyBindings';
import { CameraRig } from '../player/CameraRig';
import { Footsteps } from '../player/Footsteps';
import { LocalPlayer } from '../player/LocalPlayer';
import { Renderer } from '../renderer/Renderer';
import { Effects } from '../vfx/Effects';
import { LocalArsenal } from '../weapons/LocalArsenal';
import { Viewmodel } from '../weapons/Viewmodel';
import { WeaponController } from '../weapons/WeaponController';
import { MapRuntime, type MapLoadProgress } from '../world/MapRuntime';
import { FixedStepLoop } from './FixedStepLoop';
import type { GameSettings } from './settings';

/** 模擬頻率與伺服器 tick 相同（30 Hz），渲染以內插維持平順。 */
export const CLIENT_SIMULATION_HZ = TICK_RATE;
const MAX_FRAME_SECONDS = 0.25;
const MAX_STEPS_PER_FRAME = Math.ceil(MAX_FRAME_SECONDS * CLIENT_SIMULATION_HZ);
const MAX_RECORDED_STEPS = 3600;

export interface GameCallbacks {
  onPointerLockChange(locked: boolean): void;
  onContextLostChange(lost: boolean): void;
  onLoadProgress?(progress: MapLoadProgress): void;
}

export interface GameOptions {
  mapId: string;
  settings: GameSettings;
  bindings?: KeyBindings;
  loadout?: Partial<Loadout>;
  callbacks: GameCallbacks;
}

/**
 * 單機（訓練場）的遊戲生命週期與主迴圈。React 只負責外圍 UI；
 * 每畫格的模擬、輸入、相機與渲染都不經過 React。
 */
export class Game {
  private readonly loop = new FixedStepLoop(1 / CLIENT_SIMULATION_HZ, MAX_STEPS_PER_FRAME);
  private readonly interpolated = { x: 0, y: 0, z: 0 };
  private readonly focus = new THREE.Vector3();
  private lastFrameTime: number | null = null;
  private disposed = false;
  private recording: StepSample[] | null = null;
  private simTime = 0;
  private hits = { total: 0, headshots: 0, kills: 0 };
  private hitSerial = 0;
  private lastLook = { dx: 0, dy: 0 };

  private constructor(
    readonly hud: HudStore,
    private readonly renderer: Renderer,
    private readonly map: MapRuntime,
    private readonly input: InputManager,
    private readonly player: LocalPlayer,
    private readonly cameraRig: CameraRig,
    private readonly debug: DebugStats,
    private readonly audio: AudioSystem,
    private readonly effects: Effects,
    private readonly viewmodel: Viewmodel,
    private readonly weapons: WeaponController,
    private readonly dummies: TargetDummies,
    private readonly footsteps: Footsteps,
  ) {}

  static async create(container: HTMLElement, options: GameOptions): Promise<Game> {
    await initPhysics();
    const renderer = new Renderer(container, options.callbacks.onContextLostChange);
    const shadows = { cast: true };
    let map: MapRuntime;
    try {
      map = await MapRuntime.load(options.mapId, renderer.scene, renderer.renderer, 1 / CLIENT_SIMULATION_HZ, shadows, null, options.callbacks.onLoadProgress);
    } catch (error) {
      renderer.dispose();
      throw error;
    }
    const spawn = map.defaultSpawn();
    const [x, y, z] = spawn.position;
    const player = new LocalPlayer(map.sim, { x, y, z });
    const cameraRig = new CameraRig(renderer.camera, spawn.yaw, options.settings);
    const input = new InputManager(renderer.canvas, options.callbacks.onPointerLockChange, options.bindings);
    const gpu = renderer.gpuDescription;
    const debug = new DebugStats(renderer.renderer.info, `WebGL 2（${gpu.length > 48 ? `${gpu.slice(0, 47)}…` : gpu}）`);
    const audio = new AudioSystem();
    const effects = new Effects(renderer.scene, renderer.overlayRoot);
    const viewmodel = new Viewmodel(renderer.overlayRoot);
    const arsenal = new LocalArsenal(sanitizeLoadout({ classId: DEFAULT_CLASS_ID, ...options.loadout }));
    arsenal.current.equip(0);
    const dummies = new TargetDummies(renderer.scene, map.sim, spawn);
    const footsteps = new Footsteps(map.sim);
    const game: { current: Game | null } = { current: null };
    const resolver = WeaponController.offlineResolver(map.sim, dummies, (zone, killed) => game.current?.onDummyHit(zone, killed));
    const hud = new HudStore();
    const weapons = new WeaponController(arsenal, viewmodel, cameraRig, effects, audio, hud, map.sim, resolver, {
      matchSeed: Math.floor(Math.random() * 2 ** 31),
      playerNumber: 0,
    });
    const created = new Game(hud, renderer, map, input, player, cameraRig, debug, audio, effects, viewmodel, weapons, dummies, footsteps);
    game.current = created;
    created.applySettings(options.settings);
    hud.set({ mode: 'offline', phase: 'offline', health: 100, maxHealth: 100 });
    return created;
  }

  start(): void {
    if (debugHookEnabled()) {
      this.installDebugHook();
    }
    this.renderer.renderer.setAnimationLoop(this.frame);
  }

  applySettings(settings: GameSettings): void {
    this.cameraRig.applySettings(settings);
    this.audio.setVolumes({ master: settings.masterVolume, effects: settings.effectsVolume, music: settings.musicVolume });
  }

  setBindings(bindings: KeyBindings): void {
    this.input.setBindings(bindings);
  }

  attachDebugOutput(element: HTMLElement | null): void {
    this.debug.attach(element);
  }

  attachCrosshair(element: HTMLElement | null): void {
    this.weapons.attachCrosshair(element);
  }

  requestPointerLock(): Promise<void> {
    this.audio.resume();
    return this.input.requestPointerLock();
  }

  exitPointerLock(): void {
    this.input.exitPointerLock();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.renderer.renderer.setAnimationLoop(null);
    if (window.__frontline) {
      delete window.__frontline;
    }
    this.input.dispose();
    this.audio.dispose();
    this.dummies.dispose();
    this.effects.dispose();
    this.viewmodel.dispose();
    this.player.dispose();
    this.map.dispose();
    this.renderer.dispose();
  }

  private onDummyHit(zone: string, killed: boolean): void {
    this.hits.total++;
    if (zone === 'head') {
      this.hits.headshots++;
    }
    if (killed) {
      this.hits.kills++;
    }
    this.hitSerial++;
    this.hud.set({ hitMarker: { serial: this.hitSerial, headshot: zone === 'head', kill: killed } });
    this.audio.hitMarker(killed ? 'kill' : zone === 'head' ? 'headshot' : 'hit');
  }

  private readonly frame = (time: number): void => {
    const frameSeconds = this.lastFrameTime === null ? 0 : Math.min(MAX_FRAME_SECONDS, (time - this.lastFrameTime) / 1000);
    this.lastFrameTime = time;

    const look = this.input.consumeLook();
    this.lastLook = look;
    this.cameraRig.applyLook(look.dx, look.dy);

    const alpha = this.loop.advance(frameSeconds, (dt) => this.simulate(dt));

    const landing = this.player.consumeLanding();
    if (landing > 0) {
      this.cameraRig.addLandingImpact(landing);
    }

    const snapshot = this.player.snapshot();
    this.player.interpolatedFeet(alpha, this.interpolated);
    this.cameraRig.update(this.interpolated, snapshot.stance, this.renderer.aspect, frameSeconds);
    this.focus.set(this.interpolated.x, this.interpolated.y, this.interpolated.z);
    this.map.update(this.focus, frameSeconds);
    this.weapons.frame(frameSeconds, this.simTime, snapshot, this.lastLook, true, this.renderer.canvas.clientHeight, this.renderer.aspect);
    this.dummies.update(this.simTime, frameSeconds);
    this.effects.update(frameSeconds);
    this.renderer.camera.updateMatrixWorld();
    this.audio.updateListener(this.renderer.camera, frameSeconds);
    this.renderer.render();
    this.debug.record(frameSeconds, snapshot, this.cameraRig.yaw, this.cameraRig.pitch);
  };

  private simulate(dt: number): void {
    const input = this.input.consumeSimulationInput();
    if (input.held.has('fire')) {
      // 開火會中斷衝刺
      input.move.sprint = false;
    }
    const before = this.player.snapshot();
    const characterInput = this.player.buildInput(input, input.held.has('aim'));
    this.player.step(characterInput, this.cameraRig.yaw, dt);
    this.map.sim.step();
    this.simTime += dt;
    const after = this.player.snapshot();
    this.weapons.step(this.simTime, dt, input, after, this.cameraRig.yaw, this.cameraRig.pitch, true);
    const step = this.footsteps.step(after.feet, before.feet, after.locomotion, after.stance, after.grounded);
    if (step) {
      this.audio.footstep(null, step.surface, step.loudness * 0.6);
    }
    this.recordStep();
    if (this.player.body.position.y < this.map.manifest.killPlaneY) {
      const spawn = this.map.defaultSpawn();
      this.player.teleport({ x: spawn.position[0], y: spawn.position[1], z: spawn.position[2] });
    }
  }

  private recordStep(): void {
    if (!this.recording || this.recording.length >= MAX_RECORDED_STEPS) {
      return;
    }
    const s = this.player.snapshot();
    this.recording.push({
      step: this.recording.length,
      x: s.feet.x,
      y: s.feet.y,
      z: s.feet.z,
      speed: Math.hypot(s.velocity.x, s.velocity.z),
      vy: s.velocity.y,
      grounded: s.grounded,
      stance: s.stance,
    });
  }

  private installDebugHook(): void {
    window.__frontline = {
      snapshot: () => ({
        ...this.player.snapshot(),
        yaw: this.cameraRig.yaw,
        pitch: this.cameraRig.pitch,
        pointerLocked: this.input.isPointerLocked,
        stats: this.debug.stats,
        mapId: this.map.id,
        streaming: this.map.streamingStats(),
      }),
      look: (dx, dy) => this.input.injectLook(dx, dy),
      teleport: (x, y, z) => this.player.teleport({ x, y, z }),
      setView: (yaw, pitch) => {
        this.cameraRig.yaw = yaw;
        this.cameraRig.pitch = pitch;
      },
      startRecording: () => {
        this.recording = [];
      },
      recordedStepCount: () => this.recording?.length ?? 0,
      stopRecording: () => {
        const recorded = this.recording ?? [];
        this.recording = null;
        return recorded;
      },
      tickRate: CLIENT_SIMULATION_HZ,
      groundHeight: (x, z) => this.map.sim.groundHeight(x, z),
      sceneInfo: () => {
        let meshes = 0;
        let instancedMeshes = 0;
        let instances = 0;
        this.renderer.scene.traverse((o) => {
          if (o instanceof THREE.InstancedMesh) {
            instancedMeshes++;
            instances += o.visible ? o.count : 0;
          } else if (o instanceof THREE.Mesh) {
            meshes++;
          }
        });
        return { meshes, instancedMeshes, instances, particles: this.effects.activeParticleCount() };
      },
      weapon: () => {
        const w = this.weapons.arsenal.current;
        return {
          id: w.def.id,
          slot: this.weapons.arsenal.slot,
          ammo: w.ammo,
          reserve: w.reserve,
          reloading: w.reloading,
          fireMode: w.fireMode,
          shotSeq: w.shotSeq,
          aiming: this.weapons.isAiming,
          adsFov: this.cameraRig.currentHorizontalFov(),
        };
      },
      combat: () => ({ ...this.hits, dummiesAlive: this.dummies.aliveCount(), dummies: this.dummies.count }),
      hud: () => this.hud.get(),
      audioRunning: () => this.audio.running,
    };
  }
}
