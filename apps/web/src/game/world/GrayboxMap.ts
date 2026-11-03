import * as THREE from 'three';
import { boxRotationQuaternion, type BoxSpec, type GrayboxLayout, type SurfaceKind } from '@frontline/map-schema';

const SURFACE_COLORS: Record<SurfaceKind, number> = {
  floor: 0x7d8471,
  wall: 0x9a9d9f,
  ramp: 0xb59d6e,
  block: 0x8c8f93,
  accent: 0x6f7f8f,
  roof: 0x7a6a5a,
};

/** 有格線的表面，移動時比較能感覺速度與距離。 */
const GRIDDED: ReadonlySet<SurfaceKind> = new Set(['floor', 'ramp', 'block', 'accent']);

function createGridTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** 由灰盒資料建立可見網格。碰撞由 @frontline/map-schema 的 grayboxCollision() 另外建立。 */
export function buildGrayboxVisuals(layout: GrayboxLayout, scene: THREE.Scene): THREE.Group {
  const group = new THREE.Group();
  group.name = 'graybox';
  const gridTexture = createGridTexture();
  const plainMaterials = new Map<SurfaceKind, THREE.MeshStandardMaterial>();

  const materialFor = (spec: BoxSpec): THREE.MeshStandardMaterial => {
    if (GRIDDED.has(spec.surface)) {
      // 每個表面依尺寸設定重複次數，讓格線維持 2 m 一格。
      const texture = gridTexture.clone();
      texture.repeat.set(Math.max(spec.size[0], spec.size[1]) / 2, spec.size[2] / 2);
      texture.needsUpdate = true;
      return new THREE.MeshStandardMaterial({ color: SURFACE_COLORS[spec.surface], map: texture, roughness: 0.9 });
    }
    let material = plainMaterials.get(spec.surface);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color: SURFACE_COLORS[spec.surface], roughness: 0.85 });
      plainMaterials.set(spec.surface, material);
    }
    return material;
  };

  const quaternion = new THREE.Quaternion();

  for (const spec of layout.boxes) {
    const [sx, sy, sz] = spec.size;
    const [px, py, pz] = spec.position;
    quaternion.fromArray(boxRotationQuaternion(spec));

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), materialFor(spec));
    mesh.name = spec.name;
    mesh.position.set(px, py, pz);
    mesh.quaternion.copy(quaternion);
    mesh.castShadow = spec.surface !== 'floor';
    mesh.userData.castShadow = spec.surface !== 'floor';
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  gridTexture.dispose();
  scene.add(group);
  return group;
}
