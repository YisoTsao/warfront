import { TICK_RATE } from '@frontline/shared';
import { initPhysics } from '@frontline/simulation';
import * as THREE from 'three';
import { DebugStats } from '../debug/DebugStats';
import { debugHookEnabled, type StepSample } from '../debug/debugHook';
import { InputManager } from '../input/InputManager';
import { CameraRig } from '../player/CameraRig';
import { LocalPlayer } from '../player/LocalPlayer';
import { Renderer } from '../renderer/Renderer';
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
  callbacks: GameCallbacks;
}

/**
 * 遊戲生命週期與主迴圈。React 只負責外圍 UI，透過這個類別的少數方法溝通；
 * 每畫格的模擬、輸入、相機與渲染都不經過 React。
 */
export class Game {
  private readonly loop = new FixedStepLoop(1 / CLIENT_SIMULATION_HZ, MAX_STEPS_PER_FRAME);
  private readonly interpolated = { x: 0, y: 0, z: 0 };
  private readonly focus = new THREE.Vector3();
  private lastFrameTime: number | null = null;
  private disposed = false;
  private recording: StepSample[] | null = null;

  private constructor(
    private readonly renderer: Renderer,
    private readonly map: MapRuntime,
    private readonly input: InputManager,
    private readonly player: LocalPlayer,
    private readonly cameraRig: CameraRig,
    private readonly debug: DebugStats,
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
    const input = new InputManager(renderer.canvas, options.callbacks.onPointerLockChange);
    const gpu = renderer.gpuDescription;
    const gpuLabel = gpu.length > 48 ? `${gpu.slice(0, 47)}…` : gpu;
    const debug = new DebugStats(renderer.renderer.info, `WebGL 2（${gpuLabel}）`);
    return new Game(renderer, map, input, player, cameraRig, debug);
  }

  start(): void {
    if (debugHookEnabled()) {
      this.installDebugHook();
    }
    this.renderer.renderer.setAnimationLoop(this.frame);
  }

  applySettings(settings: GameSettings): void {
    this.cameraRig.applySettings(settings);
  }

  attachDebugOutput(element: HTMLElement | null): void {
    this.debug.attach(element);
  }

  requestPointerLock(): Promise<void> {
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
    this.player.dispose();
    this.map.dispose();
    this.renderer.dispose();
  }

  private readonly frame = (time: number): void => {
    const frameSeconds = this.lastFrameTime === null ? 0 : Math.min(MAX_FRAME_SECONDS, (time - this.lastFrameTime) / 1000);
    this.lastFrameTime = time;

    const look = this.input.consumeLook();
    this.cameraRig.applyLook(look.dx, look.dy);

    const alpha = this.loop.advance(frameSeconds, (dt) => {
      const input = this.input.consumeSimulationInput();
      const characterInput = this.player.buildInput(input, false);
      this.player.step(characterInput, this.cameraRig.yaw, dt);
      this.map.sim.step();
      this.recordStep();
      if (this.player.body.position.y < this.map.manifest.killPlaneY) {
        const spawn = this.map.defaultSpawn();
        this.player.teleport({ x: spawn.position[0], y: spawn.position[1], z: spawn.position[2] });
      }
    });

    const landing = this.player.consumeLanding();
    if (landing > 0) {
      this.cameraRig.addLandingImpact(landing);
    }

    const snapshot = this.player.snapshot();
    this.player.interpolatedFeet(alpha, this.interpolated);
    this.cameraRig.update(this.interpolated, snapshot.stance, this.renderer.aspect, frameSeconds);
    this.focus.set(this.interpolated.x, this.interpolated.y, this.interpolated.z);
    this.map.update(this.focus, frameSeconds);
    this.renderer.render();
    this.debug.record(frameSeconds, snapshot, this.cameraRig.yaw, this.cameraRig.pitch);
  };

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
        return { meshes, instancedMeshes, instances };
      },
    };
  }
}
