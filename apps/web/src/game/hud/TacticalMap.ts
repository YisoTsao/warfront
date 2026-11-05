import type { MapManifest } from '@frontline/map-schema';
import type { TeamName } from '@frontline/shared';

export interface MapMarker {
  x: number;
  z: number;
  yaw?: number;
  kind: 'teammate' | 'enemy' | 'objective' | 'target';
  team?: TeamName | null;
  label?: string;
  radius?: number;
}

const COLORS = { alpha: '#6aa8ff', bravo: '#ff8a66', neutral: '#d8d8d8', self: '#ffd040', enemy: '#ff4030' } as const;
const MINIMAP_RADIUS_METERS = 70;

/**
 * 完整地圖（按 M 開關）與小地圖：以 2D canvas 每秒重畫 10 次，不經過 React。
 * 北方朝上；小地圖以玩家為中心。
 */
export class TacticalMap {
  private minimap: HTMLCanvasElement | null = null;
  private full: HTMLCanvasElement | null = null;
  private timer = 0;
  /** 衛星圖（manifest.minimap）；載入前或沒有時畫素色底 */
  private satellite: HTMLImageElement | null = null;

  constructor(private readonly manifest: MapManifest) {
    if (manifest.minimap && typeof Image !== 'undefined') {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        this.satellite = image;
        this.timer = 0;
      };
      // 與 loadMapData 相同的地圖根目錄
      image.src = `/maps/${manifest.id}/${manifest.minimap.image}`;
    }
  }

  attachMinimap(canvas: HTMLCanvasElement | null): void {
    this.minimap = canvas;
  }

  attachFull(canvas: HTMLCanvasElement | null): void {
    this.full = canvas;
  }

  update(frameSeconds: number, self: { x: number; z: number; yaw: number }, markers: MapMarker[], showFull: boolean): void {
    this.timer -= frameSeconds;
    if (this.timer > 0) {
      return;
    }
    this.timer = 0.1;
    if (this.minimap) {
      this.draw(this.minimap, self, markers, { x: self.x, z: self.z, half: MINIMAP_RADIUS_METERS }, true);
    }
    if (this.full && showFull) {
      const b = this.manifest.bounds;
      const half = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2;
      this.draw(this.full, self, markers, { x: (b.min[0] + b.max[0]) / 2, z: (b.min[2] + b.max[2]) / 2, half: half * 1.05 }, false);
    }
  }

  private draw(canvas: HTMLCanvasElement, self: { x: number; z: number; yaw: number }, markers: MapMarker[], view: { x: number; z: number; half: number }, circular: boolean): void {
    const size = canvas.clientWidth || canvas.width;
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx || size === 0) {
      return;
    }
    const scale = size / 2 / view.half;
    const toScreen = (x: number, z: number): [number, number] => [size / 2 + (x - view.x) * scale, size / 2 + (z - view.z) * scale];
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    if (circular) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.fillStyle = 'rgba(16, 22, 18, 0.75)';
    ctx.fillRect(0, 0, size, size);
    const sat = this.manifest.minimap;
    if (this.satellite && sat) {
      const [sx0, sz0] = toScreen(sat.origin[0], sat.origin[1]);
      const [sx1, sz1] = toScreen(sat.origin[0] + sat.size, sat.origin[1] + sat.size);
      ctx.globalAlpha = circular ? 0.92 : 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.satellite, sx0, sz0, sx1 - sx0, sz1 - sz0);
      ctx.globalAlpha = 1;
      if (!circular) {
        this.grid(ctx, toScreen, scale, size);
      }
    }
    // 地圖範圍
    const b = this.manifest.bounds;
    const [x0, z0] = toScreen(b.min[0], b.min[2]);
    const [x1, z1] = toScreen(b.max[0], b.max[2]);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, z0, x1 - x0, z1 - z0);
    // 禁區
    ctx.fillStyle = 'rgba(200, 40, 30, 0.18)';
    for (const area of this.manifest.restrictedAreas) {
      const [ax, az] = toScreen(area.bounds.min[0], area.bounds.min[2]);
      const [bx, bz] = toScreen(area.bounds.max[0], area.bounds.max[2]);
      ctx.fillRect(ax, az, bx - ax, bz - az);
    }
    // 據點
    for (const m of markers.filter((m) => m.kind === 'objective')) {
      const [sx, sz] = toScreen(m.x, m.z);
      ctx.beginPath();
      ctx.arc(sx, sz, Math.max(6, (m.radius ?? 8) * scale), 0, Math.PI * 2);
      ctx.fillStyle = m.team ? `${COLORS[m.team]}55` : 'rgba(220,220,220,0.25)';
      ctx.fill();
      ctx.strokeStyle = m.team ? COLORS[m.team] : COLORS.neutral;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(10, size / 24)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.label ?? '', sx, sz);
    }
    // 人員
    for (const m of markers.filter((m) => m.kind !== 'objective')) {
      const [sx, sz] = toScreen(m.x, m.z);
      ctx.fillStyle = m.kind === 'teammate' ? (m.team ? COLORS[m.team] : COLORS.neutral) : COLORS.enemy;
      this.arrow(ctx, sx, sz, m.yaw ?? 0, 5);
    }
    // 自己
    const [px, pz] = toScreen(self.x, self.z);
    ctx.fillStyle = COLORS.self;
    this.arrow(ctx, px, pz, self.yaw, 7);
    ctx.restore();
  }

  /** 完整地圖：每 100 m 一條格線、北方指標與比例尺 */
  private grid(ctx: CanvasRenderingContext2D, toScreen: (x: number, z: number) => [number, number], scale: number, size: number): void {
    const b = this.manifest.bounds;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let v = Math.ceil(b.min[0] / 100) * 100; v <= b.max[0]; v += 100) {
      const [x] = toScreen(v, 0);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let v = Math.ceil(b.min[2] / 100) * 100; v <= b.max[2]; v += 100) {
      const [, z] = toScreen(0, v);
      ctx.beginPath();
      ctx.moveTo(0, z);
      ctx.lineTo(size, z);
      ctx.stroke();
    }
    const font = Math.max(11, size / 50);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `bold ${font}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N ▲', size - font * 2.2, font * 0.6);
    const bar = 100 * scale;
    ctx.fillRect(font, size - font * 1.6, bar, 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('100 m', font, size - font * 1.8);
  }

  /** yaw = 0 面向 -Z（畫面上方）。 */
  private arrow(ctx: CanvasRenderingContext2D, x: number, y: number, yaw: number, size: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size);
    ctx.lineTo(-size * 0.7, size);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
