/**
 * 灰盒測試地圖的資料。只描述幾何與用途，建立網格與碰撞體由 GrayboxMap 負責。
 * 單位為公尺，Y 軸朝上；玩家出生時面向 -Z。
 *
 * 每一區都對應 Phase 1 驗收清單的一個檢查項目：坡道、樓梯、跳台、蹲姿通道、牆角。
 */

export type SurfaceKind = 'floor' | 'wall' | 'ramp' | 'block' | 'accent' | 'roof';

export interface BoxSpec {
  name: string;
  /** 完整尺寸（不是半尺寸） */
  size: readonly [number, number, number];
  /** 中心位置 */
  position: readonly [number, number, number];
  /** 繞 X 軸旋轉（弧度），坡道使用 */
  rotationX?: number;
  /** 繞 Y 軸旋轉（弧度），斜牆使用 */
  rotationY?: number;
  surface: SurfaceKind;
}

export interface GrayboxLayout {
  spawn: { feet: readonly [number, number, number]; yaw: number };
  /** 掉出地圖時的回收高度 */
  killPlaneY: number;
  boxes: BoxSpec[];
}

const DEG = Math.PI / 180;

/** 由地面（y=0、z=zStart）往 -Z 方向爬升的坡道，頂端接一個平台。 */
export function ramp(name: string, angleDegrees: number, length: number, width: number, x: number, zStart: number): BoxSpec[] {
  const a = angleDegrees * DEG;
  const thickness = 0.5;
  const rise = length * Math.sin(a);
  const run = length * Math.cos(a);
  // 坡道上表面中點，再沿表面法線 (0, cos a, sin a) 往內退半個厚度。
  const topMidY = rise / 2;
  const topMidZ = zStart - run / 2;
  const platformDepth = 4;
  return [
    {
      name: `${name}-slope`,
      size: [width, thickness, length],
      position: [x, topMidY - (Math.cos(a) * thickness) / 2, topMidZ - (Math.sin(a) * thickness) / 2],
      rotationX: a,
      surface: 'ramp',
    },
    {
      name: `${name}-platform`,
      size: [width, rise, platformDepth],
      position: [x, rise / 2, zStart - run - platformDepth / 2],
      surface: 'block',
    },
  ];
}

/** 往 -Z 方向上升的樓梯，頂端接平台。 */
export function stairs(name: string, steps: number, rise: number, depth: number, width: number, x: number, zStart: number): BoxSpec[] {
  const boxes: BoxSpec[] = [];
  for (let i = 0; i < steps; i++) {
    const top = (i + 1) * rise;
    boxes.push({
      name: `${name}-step-${i + 1}`,
      size: [width, top, depth],
      position: [x, top / 2, zStart - (i + 0.5) * depth],
      surface: i % 2 === 0 ? 'block' : 'accent',
    });
  }
  const height = steps * rise;
  const landingDepth = 3;
  boxes.push({
    name: `${name}-landing`,
    size: [width, height, landingDepth],
    position: [x, height / 2, zStart - steps * depth - landingDepth / 2],
    surface: 'block',
  });
  return boxes;
}

function wall(name: string, size: readonly [number, number, number], position: readonly [number, number, number], rotationY?: number): BoxSpec {
  return rotationY === undefined
    ? { name, size, position, surface: 'wall' }
    : { name, size, position, rotationY, surface: 'wall' };
}

/** 蹲姿通道的淨高：站姿（1.84 m）進不去、蹲姿（1.2 m）進得去。 */
export const TUNNEL_CLEARANCE = 1.4;

function crouchTunnel(x: number, zStart: number, length: number): BoxSpec[] {
  const innerWidth = 2;
  const wallThickness = 0.5;
  const roofThickness = 0.4;
  const centerZ = zStart - length / 2;
  const sideOffset = innerWidth / 2 + wallThickness / 2;
  return [
    wall('tunnel-left', [wallThickness, TUNNEL_CLEARANCE, length], [x - sideOffset, TUNNEL_CLEARANCE / 2, centerZ]),
    wall('tunnel-right', [wallThickness, TUNNEL_CLEARANCE, length], [x + sideOffset, TUNNEL_CLEARANCE / 2, centerZ]),
    {
      name: 'tunnel-roof',
      size: [innerWidth + wallThickness * 2, roofThickness, length],
      position: [x, TUNNEL_CLEARANCE + roofThickness / 2, centerZ],
      surface: 'roof',
    },
  ];
}

function buildLayout(): GrayboxLayout {
  const half = 60;
  const wallHeight = 4;
  const boxes: BoxSpec[] = [
    { name: 'floor', size: [half * 2, 1, half * 2], position: [0, -0.5, 0], surface: 'floor' },
    wall('perimeter-north', [half * 2 + 2, wallHeight, 1], [0, wallHeight / 2, -half - 0.5]),
    wall('perimeter-south', [half * 2 + 2, wallHeight, 1], [0, wallHeight / 2, half + 0.5]),
    wall('perimeter-west', [1, wallHeight, half * 2], [-half - 0.5, wallHeight / 2, 0]),
    wall('perimeter-east', [1, wallHeight, half * 2], [half + 0.5, wallHeight / 2, 0]),

    // 坡道：15°、30°、40° 可以走上去，55° 超過爬坡上限會滑下。
    ...ramp('ramp-15', 15, 8, 4, -36, 0),
    ...ramp('ramp-30', 30, 8, 4, -29, 0),
    ...ramp('ramp-40', 40, 8, 4, -22, 0),
    ...ramp('ramp-55', 55, 6, 4, -15, 0),

    // 樓梯：每階 0.18 m，低於自動跨步上限 0.35 m。
    ...stairs('stairs', 10, 0.18, 0.32, 3, -6, 0),

    // 跳台：0.5 m 可直接跳上，0.9 m 需要跳躍加跨步，1.5 m 跳不上去。
    { name: 'jump-0.5', size: [2, 0.5, 2], position: [4, 0.25, -4], surface: 'block' },
    { name: 'jump-0.9', size: [2, 0.9, 2], position: [8, 0.45, -4], surface: 'accent' },
    { name: 'jump-1.5', size: [2, 1.5, 2], position: [12, 0.75, -4], surface: 'block' },

    ...crouchTunnel(22, -1, 6),

    // 掩體與柱子
    { name: 'cover-center', size: [4, 1, 0.6], position: [0, 0.5, -20], surface: 'accent' },
    { name: 'cover-left', size: [4, 1, 0.6], position: [-7, 0.5, -24], surface: 'accent' },
    { name: 'cover-right', size: [4, 1, 0.6], position: [7, 0.5, -24], surface: 'accent' },
    { name: 'pillar-1', size: [1, 4, 1], position: [-10, 2, -32], surface: 'block' },
    { name: 'pillar-2', size: [1, 4, 1], position: [0, 2, -34], surface: 'block' },
    { name: 'pillar-3', size: [1, 4, 1], position: [10, 2, -32], surface: 'block' },

    // 牆角：直角與 30° 銳角，用來檢查卡牆與抖動。
    wall('corner-l-a', [10, 3, 0.5], [15, 1.5, 25]),
    wall('corner-l-b', [0.5, 3, 10], [20, 1.5, 30]),
    wall('corner-acute-a', [10, 3, 0.5], [-5, 1.5, 25]),
    wall('corner-acute-b', [10, 3, 0.5], [-5 * Math.cos(30 * DEG), 1.5, 25 + 5 * Math.sin(30 * DEG)], 30 * DEG),
  ];

  return {
    spawn: { feet: [0, 0, 12], yaw: 0 },
    killPlaneY: -30,
    boxes,
  };
}

export const GRAYBOX_LAYOUT: GrayboxLayout = buildLayout();
