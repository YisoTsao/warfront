import { DEFAULT_CLASS_ID, sanitizeLoadout, type Loadout } from '@frontline/game-config';
import { TICK_RATE } from '@frontline/shared';
import { initPhysics } from '@frontline/simulation';
import * as THREE from 'three';
import { AudioSystem } from '../audio/AudioSystem';
import { DebugStats } from '../debug/DebugStats';
import { debugHookEnabled, type FrontlineDebugHook, type StepSample } from '../debug/debugHook';
import { HudStore } from '../hud/HudStore';
import { TacticalMap, type MapMarker } from '../hud/TacticalMap';
import { InputManager, type SimulationInput } from '../input/InputManager';
import type { KeyBindings } from '../input/keyBindings';
import { CameraRig } from '../player/CameraRig';
import { Footsteps } from '../player/Footsteps';
import { LocalPlayer } from '../player/LocalPlayer';
import { Renderer } from '../renderer/Renderer';
import { Effects } from '../vfx/Effects';
import { LocalArsenal } from '../weapons/LocalArsenal';
import { Viewmodel } from '../weapons/Viewmodel';
import { WeaponController, type PelletResolver } from '../weapons/WeaponController';
import { MapRuntime, type MapLoadProgress } from '../world/MapRuntime';
import { FixedStepLoop } from './FixedStepLoop';
import { QualityController, streamScaleFor } from './QualityController';
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

export interface GameBaseOptions {
  mapId: string;
  settings: GameSettings;
  bindings?: KeyBindings;
  loadout?: Partial<Loadout>;
  callbacks: GameCallbacks;
  matchSeed: number;
  playerNumber: number;
}

export interface GameParts {
  renderer: Renderer;
  map: MapRuntime;
  input: InputManager;
  player: LocalPlayer;
  cameraRig: CameraRig;
  debug: DebugStats;
  audio: AudioSystem;
  effects: Effects;
  viewmodel: Viewmodel;
  weapons: WeaponController;
  hud: HudStore;
  footsteps: Footsteps;
}

/** 建立單機與連線共用的部件（渲染、地圖、玩家、武器、特效、音效、HUD）。 */
export async function createGameParts(container: HTMLElement, options: GameBaseOptions, resolverFactory: (parts: Omit<GameParts, 'weapons'>) => PelletResolver): Promise<GameParts> {
  await initPhysics();
  const renderer = new Renderer(container, options.callbacks.onContextLostChange);
  let map: MapRuntime;
  try {
    map = await MapRuntime.load(options.mapId, renderer.scene, renderer.renderer, 1 / CLIENT_SIMULATION_HZ, { cast: true }, null, options.callbacks.onLoadProgress, streamScaleFor(options.settings));
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  const spawn = map.defaultSpawn();
  const player = new LocalPlayer(map.sim, { x: spawn.position[0], y: spawn.position[1], z: spawn.position[2] });
  const cameraRig = new CameraRig(renderer.camera, spawn.yaw, options.settings);
  const input = new InputManager(renderer.canvas, options.callbacks.onPointerLockChange, options.bindings);
  const gpu = renderer.gpuDescription;
  const debug = new DebugStats(renderer.renderer.info, `WebGL 2（${gpu.length > 48 ? `${gpu.slice(0, 47)}…` : gpu}）`);
  const audio = new AudioSystem();
  const effects = new Effects(renderer.scene, renderer.overlayRoot);
  const viewmodel = new Viewmodel(renderer.overlayRoot);
  const hud = new HudStore();
  const footsteps = new Footsteps(map.sim);
  const parts = { renderer, map, input, player, cameraRig, debug, audio, effects, viewmodel, hud, footsteps };
  const arsenal = new LocalArsenal(sanitizeLoadout({ classId: DEFAULT_CLASS_ID, ...options.loadout }));
  arsenal.current.equip(0);
  const weapons = new WeaponController(arsenal, viewmodel, cameraRig, effects, audio, hud, map.sim, resolverFactory(parts), {
    matchSeed: options.matchSeed,
    playerNumber: options.playerNumber,
  });
  return { ...parts, weapons };
}

/**
 * 主迴圈與共用行為。子類別實作每個模擬步驟（simulateStep）與額外的畫格更新。
 * React 只負責外圍 UI；每畫格的模擬、輸入、相機與渲染都不經過 React。
 */
export abstract class GameBase {
  readonly hud: HudStore;
  protected readonly renderer: Renderer;
  protected readonly map: MapRuntime;
  protected readonly input: InputManager;
  protected readonly player: LocalPlayer;
  protected readonly cameraRig: CameraRig;
  protected readonly debug: DebugStats;
  protected readonly audio: AudioSystem;
  protected readonly effects: Effects;
  protected readonly viewmodel: Viewmodel;
  protected weapons: WeaponController;
  protected readonly footsteps: Footsteps;
  protected readonly loop = new FixedStepLoop(1 / CLIENT_SIMULATION_HZ, MAX_STEPS_PER_FRAME);
  protected readonly interpolated = { x: 0, y: 0, z: 0 };
  protected readonly focus = new THREE.Vector3();
  protected simTime = 0;
  protected lastLook = { dx: 0, dy: 0 };
  protected recording: StepSample[] | null = null;
  protected readonly tacticalMap: TacticalMap;
  private readonly quality: QualityController;
  private lastFrameTime: number | null = null;
  private disposed = false;
  private hitSerial = 0;

  protected constructor(parts: GameParts) {
    this.hud = parts.hud;
    this.renderer = parts.renderer;
    this.map = parts.map;
    this.input = parts.input;
    this.player = parts.player;
    this.cameraRig = parts.cameraRig;
    this.debug = parts.debug;
    this.audio = parts.audio;
    this.effects = parts.effects;
    this.viewmodel = parts.viewmodel;
    this.weapons = parts.weapons;
    this.footsteps = parts.footsteps;
    this.tacticalMap = new TacticalMap(parts.map.manifest);
    this.quality = new QualityController(parts.renderer, parts.map, parts.effects);
    this.input.uiListener = (action, down) => {
      if (action === 'scoreboard') {
        this.hud.set({ showScoreboard: down });
      } else if (action === 'tacticalMap') {
        this.hud.set({ showMap: down });
      }
    };
  }

  start(): void {
    if (debugHookEnabled()) {
      window.__frontline = this.createDebugHook();
    }
    this.renderer.renderer.setAnimationLoop(this.frame);
  }

  applySettings(settings: GameSettings): void {
    this.cameraRig.applySettings(settings);
    this.audio.setVolumes({ master: settings.masterVolume, effects: settings.effectsVolume, music: settings.musicVolume });
    this.quality.apply(settings);
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

  attachMinimap(canvas: HTMLCanvasElement | null): void {
    this.tacticalMap.attachMinimap(canvas);
  }

  attachTacticalMap(canvas: HTMLCanvasElement | null): void {
    this.tacticalMap.attachFull(canvas);
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
    this.disposeExtras();
    this.input.dispose();
    this.audio.dispose();
    this.effects.dispose();
    this.viewmodel.dispose();
    this.player.dispose();
    this.map.dispose();
    this.renderer.dispose();
  }

  /** 每個模擬步驟（1/30 秒）。 */
  protected abstract simulateStep(dt: number, input: SimulationInput): void;
  /** 每個渲染畫格（模擬之後、渲染之前）。 */
  protected abstract onFrame(frameSeconds: number): void;
  /** 本機玩家是否存活（決定武器模型與輸入）。 */
  protected abstract localAlive(): boolean;
  protected abstract mapMarkers(): MapMarker[];
  protected disposeExtras(): void {}
  protected extendDebugHook(_hook: FrontlineDebugHook): void {}

  protected showHitMarker(zone: string, killed: boolean): void {
    this.hitSerial++;
    this.hud.set({ hitMarker: { serial: this.hitSerial, headshot: zone === 'head', kill: killed } });
    this.audio.hitMarker(killed ? 'kill' : zone === 'head' ? 'headshot' : 'hit');
  }

  /** 共用的本機玩家推進：輸入 → 角色 → 武器 → 腳步聲。 */
  protected stepLocal(dt: number, input: SimulationInput, canAct: boolean): void {
    if (input.held.has('fire')) {
      input.move.sprint = false;
    }
    const before = this.player.snapshot();
    const characterInput = this.player.buildInput(input, input.held.has('aim'));
    this.player.step(characterInput, this.cameraRig.yaw, dt);
    this.map.sim.step();
    this.simTime += dt;
    const after = this.player.snapshot();
    this.weapons.step(this.simTime, dt, input, after, this.cameraRig.yaw, this.cameraRig.pitch, canAct);
    const step = this.footsteps.step(after.feet, before.feet, after.locomotion, after.stance, after.grounded);
    if (step) {
      this.audio.footstep(null, step.surface, step.loudness * 0.6);
    }
    this.recordStep();
  }

  private readonly frame = (time: number): void => {
    const frameSeconds = this.lastFrameTime === null ? 0 : Math.min(MAX_FRAME_SECONDS, (time - this.lastFrameTime) / 1000);
    this.lastFrameTime = time;

    const look = this.input.consumeLook();
    this.lastLook = look;
    this.cameraRig.applyLook(look.dx, look.dy);

    const alpha = this.loop.advance(frameSeconds, (dt) => this.simulateStep(dt, this.input.consumeSimulationInput()));

    const landing = this.player.consumeLanding();
    if (landing > 0) {
      this.cameraRig.addLandingImpact(landing);
    }
    const snapshot = this.player.snapshot();
    this.player.interpolatedFeet(alpha, this.interpolated);
    this.cameraRig.update(this.interpolated, snapshot.stance, this.renderer.aspect, frameSeconds);
    this.focus.set(this.interpolated.x, this.interpolated.y, this.interpolated.z);
    this.map.update(this.focus, frameSeconds);
    const alive = this.localAlive();
    this.weapons.frame(frameSeconds, this.simTime, snapshot, this.lastLook, alive, this.renderer.canvas.clientHeight, this.renderer.aspect);
    this.onFrame(frameSeconds);
    this.effects.update(frameSeconds);
    this.renderer.camera.updateMatrixWorld();
    this.audio.updateListener(this.renderer.camera, frameSeconds);
    this.tacticalMap.update(frameSeconds, { x: this.interpolated.x, z: this.interpolated.z, yaw: this.cameraRig.yaw }, this.mapMarkers(), this.hud.get().showMap);
    this.renderer.render();
    this.debug.record(frameSeconds, snapshot, this.cameraRig.yaw, this.cameraRig.pitch);
    this.quality.update(frameSeconds);
  };

  protected recordStep(): void {
    if (!this.recording || this.recording.length >= MAX_RECORDED_STEPS) {
      return;
    }
    const s = this.player.snapshot();
    this.recording.push({ step: this.recording.length, x: s.feet.x, y: s.feet.y, z: s.feet.z, speed: Math.hypot(s.velocity.x, s.velocity.z), vy: s.velocity.y, grounded: s.grounded, stance: s.stance });
  }

  private createDebugHook(): FrontlineDebugHook {
    const hook: FrontlineDebugHook = {
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
        return { id: w.def.id, slot: this.weapons.arsenal.slot, ammo: w.ammo, reserve: w.reserve, reloading: w.reloading, fireMode: w.fireMode, shotSeq: w.shotSeq, aiming: this.weapons.isAiming, adsFov: this.cameraRig.currentHorizontalFov() };
      },
      combat: () => ({}),
      hud: () => this.hud.get(),
      audioRunning: () => this.audio.running,
      quality: () => this.quality.state(),
    };
    this.extendDebugHook(hook);
    return hook;
  }
}
