import { DEFAULT_KEY_BINDINGS, axis, buildCodeLookup, type InputAction, type KeyBindings } from './keyBindings';

/** 一個模擬步驟取用的輸入。 */
export interface SimulationInput {
  move: { forward: number; right: number; sprint: boolean };
  /** 目前按住的動作 */
  held: ReadonlySet<InputAction>;
  /** 自上一個模擬步驟以來新按下的動作（每個只會被取用一次） */
  pressed: ReadonlySet<InputAction>;
}

/** 介面（不經過 Pointer Lock）也要知道的按鍵狀態，例如計分板。 */
export type UiActionListener = (action: InputAction, down: boolean) => void;

/**
 * 收集鍵盤與滑鼠輸入。只有在 Pointer Lock 期間才接受遊戲輸入；
 * 失去焦點、切換分頁或解除鎖定時會清除所有按鍵，避免角色卡在「一直往前走」。
 */
export class InputManager {
  private readonly held = new Set<InputAction>();
  private pressed = new Set<InputAction>();
  private lookup: Map<string, InputAction>;
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private locked = false;
  private readonly disposers: Array<() => void> = [];
  uiListener: UiActionListener | null = null;

  constructor(
    private readonly target: HTMLElement,
    private readonly onPointerLockChange: (locked: boolean) => void,
    bindings: KeyBindings = DEFAULT_KEY_BINDINGS,
  ) {
    this.lookup = buildCodeLookup(bindings);
    this.listen(document, 'pointerlockchange', this.handlePointerLockChange);
    this.listen(document, 'pointerlockerror', this.handlePointerLockError);
    this.listen(window, 'keydown', this.handleKeyDown);
    this.listen(window, 'keyup', this.handleKeyUp);
    this.listen(document, 'mousemove', this.handleMouseMove);
    this.listen(document, 'mousedown', this.handleMouseDown);
    this.listen(document, 'mouseup', this.handleMouseUp);
    this.listen(document, 'wheel', this.handleWheel, { passive: false });
    this.listen(document, 'contextmenu', this.handleContextMenu);
    this.listen(window, 'blur', this.clear);
    this.listen(document, 'visibilitychange', this.handleVisibilityChange);
  }

  get isPointerLocked(): boolean {
    return this.locked;
  }

  isHeld(action: InputAction): boolean {
    return this.held.has(action);
  }

  setBindings(bindings: KeyBindings): void {
    this.lookup = buildCodeLookup(bindings);
    this.clear();
  }

  /** 必須由使用者點擊事件觸發，瀏覽器才會允許。 */
  async requestPointerLock(): Promise<void> {
    const result: unknown = this.target.requestPointerLock();
    if (result instanceof Promise) {
      await result;
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.target) {
      document.exitPointerLock();
    }
  }

  /** 取出並清空這一個渲染畫格累積的滑鼠位移（像素）。 */
  consumeLook(): { dx: number; dy: number } {
    const delta = { dx: this.lookDeltaX, dy: this.lookDeltaY };
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return delta;
  }

  /** 供測試與除錯注入視角位移。 */
  injectLook(dx: number, dy: number): void {
    this.lookDeltaX += dx;
    this.lookDeltaY += dy;
  }

  /** 每個模擬步驟呼叫一次。 */
  consumeSimulationInput(): SimulationInput {
    const input: SimulationInput = {
      move: {
        forward: axis(this.held.has('moveForward'), this.held.has('moveBackward')),
        right: axis(this.held.has('moveRight'), this.held.has('moveLeft')),
        sprint: this.held.has('sprint'),
      },
      held: new Set(this.held),
      pressed: this.pressed,
    };
    this.pressed = new Set();
    return input;
  }

  dispose(): void {
    this.exitPointerLock();
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
  }

  private listen(source: Window | Document, type: string, handler: (event: never) => void, options?: AddEventListenerOptions): void {
    const listener = handler as EventListener;
    source.addEventListener(type, listener, options);
    this.disposers.push(() => source.removeEventListener(type, listener, options));
  }

  private press(action: InputAction): void {
    if (!this.held.has(action)) {
      this.pressed.add(action);
    }
    this.held.add(action);
    this.uiListener?.(action, true);
  }

  private release(action: InputAction): void {
    this.held.delete(action);
    this.uiListener?.(action, false);
  }

  private readonly handlePointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.target;
    if (!this.locked) {
      this.clear();
    }
    this.onPointerLockChange(this.locked);
  };

  private readonly handlePointerLockError = (): void => {
    this.locked = false;
    this.onPointerLockChange(false);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.locked) {
      return;
    }
    const action = this.lookup.get(event.code);
    if (!action) {
      return;
    }
    // 避免空白鍵捲動頁面、Tab 移動焦點。
    event.preventDefault();
    if (!event.repeat) {
      this.press(action);
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const action = this.lookup.get(event.code);
    if (action) {
      this.release(action);
    }
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.locked) {
      return;
    }
    const action = this.lookup.get(`Mouse${event.button}`);
    if (action) {
      event.preventDefault();
      this.press(action);
    }
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    const action = this.lookup.get(`Mouse${event.button}`);
    if (action) {
      this.release(action);
    }
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.locked || event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    const action = this.lookup.get(event.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    if (action) {
      this.pressed.add(action);
    }
  };

  private readonly handleContextMenu = (event: Event): void => {
    if (this.locked) {
      event.preventDefault();
    }
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) {
      return;
    }
    this.lookDeltaX += event.movementX;
    this.lookDeltaY += event.movementY;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      this.clear();
    }
  };

  private readonly clear = (): void => {
    for (const action of this.held) {
      this.uiListener?.(action, false);
    }
    this.held.clear();
    this.pressed = new Set();
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
  };
}
