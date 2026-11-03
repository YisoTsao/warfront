import * as THREE from 'three';

/** 渲染器與場景的基本設定。WebGL 2 為基準路徑；光源與霧由地圖環境設定。 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly resizeObserver: ResizeObserver;
  private contextLost = false;
  private renderScale = 1;
  private maxPixelRatio = 2;

  constructor(
    private readonly container: HTMLElement,
    private readonly onContextChange: (lost: boolean) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'game-canvas';
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1500);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get aspect(): number {
    return this.camera.aspect;
  }

  /** GPU 名稱（瀏覽器允許時），寫進效能紀錄用。 */
  get gpuDescription(): string {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const value: unknown = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof value === 'string' ? value : '未知';
  }

  /** 渲染解析度倍率（動態解析度與畫質等級使用）。 */
  setRenderScale(scale: number, maxPixelRatio = this.maxPixelRatio): void {
    const clamped = Math.min(1, Math.max(0.4, scale));
    if (Math.abs(clamped - this.renderScale) < 0.01 && maxPixelRatio === this.maxPixelRatio) {
      return;
    }
    this.renderScale = clamped;
    this.maxPixelRatio = maxPixelRatio;
    this.resize();
  }

  get currentRenderScale(): number {
    return this.renderScale;
  }

  setShadowsEnabled(enabled: boolean): void {
    if (this.renderer.shadowMap.enabled !== enabled) {
      this.renderer.shadowMap.enabled = enabled;
      this.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of materials) {
            m.needsUpdate = true;
          }
        }
      });
    }
  }

  render(): void {
    if (!this.contextLost) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) {
              value.dispose();
            }
          }
          material.dispose();
        }
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio) * this.renderScale);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.onContextChange(true);
  };

  private readonly handleContextRestored = (): void => {
    this.contextLost = false;
    this.onContextChange(false);
  };
}
