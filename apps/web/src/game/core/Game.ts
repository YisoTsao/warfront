import { GRAYBOX_LAYOUT } from '../world/grayboxLayout';
import { buildGrayboxMap } from '../world/GrayboxMap';
import { CameraRig } from '../player/CameraRig';
import { PlayerController, type Vec3 } from '../player/PlayerController';
import { DebugStats } from '../debug/DebugStats';
import { debugHookEnabled, type StepSample } from '../debug/debugHook';
import { InputManager } from '../input/InputManager';
import { PhysicsWorld, initPhysics } from '../physics/PhysicsWorld';
import { Renderer } from '../renderer/Renderer';
import { FixedStepLoop } from './FixedStepLoop';
import type { GameSettings } from './settings';

/** 客戶端本機模擬頻率。之後接上伺服器時，預測步長要與伺服器 tick 對齊（見 docs/NETWORKING_SPEC.md）。 */
export const CLIENT_SIMULATION_HZ = 60;
const MAX_FRAME_SECONDS = 0.25;
/** 等於 MAX_FRAME_SECONDS 內的步數：只要單一畫格不超過 0.25 秒，模擬就不會落後於實際時間。 */
const MAX_STEPS_PER_FRAME = Math.ceil(MAX_FRAME_SECONDS * CLIENT_SIMULATION_HZ);
/** 除錯紀錄最多保留的步數（60 Hz 下約 60 秒） */
const MAX_RECORDED_STEPS = 3600;

export interface GameCallbacks {
  onPointerLockChange(locked: boolean): void;
  onContextLostChange(lost: boolean): void;
}

/**
 * 遊戲生命週期與主迴圈。React 只負責外圍 UI，透過這個類別的少數方法溝通；
 * 每畫格的模擬、輸入、相機與渲染都不經過 React。
 */
export class Game {
  private readonly loop = new FixedStepLoop(1 / CLIENT_SIMULATION_HZ, MAX_STEPS_PER_FRAME);
  private readonly interpolated: Vec3 = { x: 0, y: 0, z: 0 };
  private lastFrameTime: number | null = null;
  private disposed = false;
  /** 除錯用：每個模擬步驟的紀錄；null 表示沒有在紀錄 */
  private recording: StepSample[] | null = null;

  private constructor(
    private readonly renderer: Renderer,
    private readonly physics: PhysicsWorld,
    private readonly input: InputManager,
    private readonly player: PlayerController,
    private readonly cameraRig: CameraRig,
    private readonly debug: DebugStats,
  ) {}

  static async create(container: HTMLElement, settings: GameSettings, callbacks: GameCallbacks): Promise<Game> {
    await initPhysics();
    const renderer = new Renderer(container, callbacks.onContextLostChange);
    const physics = new PhysicsWorld(1 / CLIENT_SIMULATION_HZ);
    buildGrayboxMap(GRAYBOX_LAYOUT, renderer.scene, physics);
    // 先推進一次，讓靜態碰撞體進入查詢結構。
    physics.step();

    const [x, y, z] = GRAYBOX_LAYOUT.spawn.feet;
    const player = new PlayerController(physics, { x, y, z }, GRAYBOX_LAYOUT.killPlaneY);
    const cameraRig = new CameraRig(renderer.camera, GRAYBOX_LAYOUT.spawn.yaw, settings);
    const input = new InputManager(renderer.canvas, callbacks.onPointerLockChange);
    const gpu = renderer.gpuDescription;
    const gpuLabel = gpu.length > 48 ? `${gpu.slice(0, 47)}…` : gpu;
    const debug = new DebugStats(renderer.renderer.info, `WebGL 2（${gpuLabel}）`);
    return new Game(renderer, physics, input, player, cameraRig, debug);
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
    this.physics.dispose();
    this.renderer.dispose();
  }

  private readonly frame = (time: number): void => {
    const frameSeconds =
      this.lastFrameTime === null ? 0 : Math.min(MAX_FRAME_SECONDS, (time - this.lastFrameTime) / 1000);
    this.lastFrameTime = time;

    const look = this.input.consumeLook();
    this.cameraRig.applyLook(look.dx, look.dy);

    const alpha = this.loop.advance(frameSeconds, (dt) => {
      const input = this.input.consumeSimulationInput();
      this.player.step(input, this.cameraRig.yaw, dt);
      this.physics.step();
      this.recordStep();
    });

    const landing = this.player.consumeLanding();
    if (landing) {
      this.cameraRig.addLandingImpact(landing.impactSpeed);
    }

    const snapshot = this.player.snapshot();
    this.player.interpolatedFeet(alpha, this.interpolated);
    this.cameraRig.update(this.interpolated, snapshot.stance, this.renderer.aspect, frameSeconds);
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
    };
  }
}
