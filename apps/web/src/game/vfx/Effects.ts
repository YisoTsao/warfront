import * as THREE from 'three';

const MATERIAL_COLORS: Record<string, number> = {
  dirt: 0x6b5a40,
  sand: 0x9a8a62,
  rock: 0x8a8884,
  stone: 0x9a9894,
  concrete: 0xa8a8a2,
  plaster: 0xc8c0b0,
  wood: 0x7a5a38,
  metal: 0xffd27a,
  water: 0xcfe6f0,
  default: 0x9a958a,
  flesh: 0x8a1010,
};

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  grow: number;
  active: boolean;
}

interface Tracer {
  line: THREE.Line;
  life: number;
  active: boolean;
}

/**
 * 物件池化的特效：槍口火光、曳光彈、命中粉塵與火花、血霧、彈殼、爆炸。
 * 所有幾何與材質都預先建立，戰鬥中不建立也不釋放 GPU 資源。
 */
export class Effects {
  private readonly group = new THREE.Group();
  private readonly particles: Particle[] = [];
  private readonly tracers: Tracer[] = [];
  private readonly flashLight: THREE.PointLight;
  private readonly flash: THREE.Mesh;
  private flashLife = 0;
  private particleCursor = 0;
  private tracerCursor = 0;
  private readonly particleGeometry = new THREE.IcosahedronGeometry(0.05, 0);
  private readonly shellGeometry = new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6);
  private readonly materials = new Map<number, THREE.MeshBasicMaterial>();
  private readonly shellMaterial = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 0.8, roughness: 0.35 });
  /** 依畫質降低特效數量 */
  density = 1;

  constructor(
    private readonly scene: THREE.Scene,
    overlay: THREE.Object3D,
  ) {
    this.group.name = 'effects';
    scene.add(this.group);
    for (let i = 0; i < 240; i++) {
      const mesh = new THREE.Mesh(this.particleGeometry, this.material(0xffffff));
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.particles.push({ mesh, velocity: new THREE.Vector3(), life: 0, maxLife: 1, gravity: 0, grow: 0, active: false });
    }
    for (let i = 0; i < 48; i++) {
      const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffe6a0, transparent: true, opacity: 0.9 }));
      line.visible = false;
      line.frustumCulled = false;
      this.group.add(line);
      this.tracers.push({ line, life: 0, active: false });
    }
    // 槍口火光：放在武器模型的槍口上（疊加場景），燈光放在主場景照亮附近
    this.flash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.06, 0),
      new THREE.MeshBasicMaterial({ color: 0xffd38a, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.flash.visible = false;
    overlay.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffc070, 0, 8, 2);
    scene.add(this.flashLight);
  }

  private material(color: number): THREE.MeshBasicMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false });
      this.materials.set(color, m);
    }
    return m;
  }

  private spawnParticle(position: THREE.Vector3, velocity: THREE.Vector3, color: number, life: number, scale: number, gravity: number, grow = 0, geometry: THREE.BufferGeometry = this.particleGeometry, material?: THREE.Material): void {
    const p = this.particles[this.particleCursor]!;
    this.particleCursor = (this.particleCursor + 1) % this.particles.length;
    p.mesh.geometry = geometry;
    p.mesh.material = material ?? this.material(color);
    p.mesh.position.copy(position);
    p.mesh.scale.setScalar(scale);
    p.mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    p.mesh.visible = true;
    p.velocity.copy(velocity);
    p.life = life;
    p.maxLife = life;
    p.gravity = gravity;
    p.grow = grow;
    p.active = true;
  }

  /** 開槍者自己的槍口火光（在武器模型的槍口位置）。 */
  muzzleFlash(localMuzzle: THREE.Object3D | null, worldMuzzle: THREE.Vector3, scale: number): void {
    if (scale <= 0.05) {
      return;
    }
    if (localMuzzle) {
      localMuzzle.add(this.flash);
      this.flash.position.set(0, -0.03, 0);
    }
    this.flash.scale.setScalar(scale * (0.8 + Math.random() * 0.5));
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.visible = true;
    this.flashLife = 0.045;
    this.flashLight.position.copy(worldMuzzle);
    this.flashLight.intensity = 6 * scale;
  }

  /** 其他玩家的槍口火光（主場景中）。 */
  remoteMuzzleFlash(position: THREE.Vector3, scale: number): void {
    if (scale <= 0.05) {
      return;
    }
    this.spawnParticle(position, new THREE.Vector3(), 0xffd38a, 0.05, 1.6 * scale, 0);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const t = this.tracers[this.tracerCursor]!;
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
    const attr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    // 曳光只畫一段，看起來像飛行中的彈頭
    const dir = to.clone().sub(from);
    const length = dir.length();
    const start = from.clone().addScaledVector(dir, Math.min(0.4, 2 / Math.max(length, 0.01)));
    attr.setXYZ(0, start.x, start.y, start.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    t.line.geometry.computeBoundingSphere();
    t.life = 0.06;
    t.active = true;
    t.line.visible = true;
    (t.line.material as THREE.LineBasicMaterial).opacity = 0.9;
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, material: string): void {
    const color = MATERIAL_COLORS[material] ?? MATERIAL_COLORS.default!;
    const count = Math.max(2, Math.round(6 * this.density));
    for (let i = 0; i < count; i++) {
      const v = normal.clone().multiplyScalar(1.5 + Math.random() * 2).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2));
      this.spawnParticle(point, v, color, 0.4 + Math.random() * 0.3, 0.6 + Math.random() * 0.6, 6, 1.5);
    }
    if (material === 'metal' || material === 'stone' || material === 'rock') {
      for (let i = 0; i < 3; i++) {
        const v = normal.clone().multiplyScalar(4).add(new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 3, (Math.random() - 0.5) * 5));
        this.spawnParticle(point, v, 0xffe090, 0.15, 0.25, 12);
      }
    }
  }

  blood(point: THREE.Vector3, direction: THREE.Vector3): void {
    const count = Math.max(3, Math.round(7 * this.density));
    for (let i = 0; i < count; i++) {
      const v = direction.clone().multiplyScalar(1.5).add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2));
      this.spawnParticle(point, v, MATERIAL_COLORS.flesh!, 0.35, 0.8 + Math.random() * 0.6, 4, 2);
    }
  }

  shell(position: THREE.Vector3, right: THREE.Vector3): void {
    const v = right.clone().multiplyScalar(1.5 + Math.random()).add(new THREE.Vector3(0, 1.5 + Math.random(), 0));
    this.spawnParticle(position, v, 0, 0.7, 1, 9.8, 0, this.shellGeometry, this.shellMaterial);
  }

  explosion(point: THREE.Vector3): void {
    const count = Math.round(40 * this.density) + 10;
    for (let i = 0; i < count; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize();
      const fire = i < count / 3;
      this.spawnParticle(point, dir.multiplyScalar(fire ? 6 + Math.random() * 6 : 2 + Math.random() * 3), fire ? 0xffa040 : 0x4a4640, fire ? 0.35 : 1.4, fire ? 3 : 4, fire ? 2 : -0.5, fire ? 4 : 2.5);
    }
    this.flashLight.position.copy(point).add(new THREE.Vector3(0, 1, 0));
    this.flashLight.intensity = 60;
    this.flashLight.distance = 25;
    this.flashLife = 0.12;
  }

  update(frameSeconds: number): void {
    if (this.flashLife > 0) {
      this.flashLife -= frameSeconds;
      if (this.flashLife <= 0) {
        this.flash.visible = false;
        this.flashLight.intensity = 0;
        this.flashLight.distance = 8;
      }
    }
    for (const p of this.particles) {
      if (!p.active) {
        continue;
      }
      p.life -= frameSeconds;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.velocity.y -= p.gravity * frameSeconds;
      p.velocity.multiplyScalar(Math.exp(-frameSeconds * 1.5));
      p.mesh.position.addScaledVector(p.velocity, frameSeconds);
      p.mesh.scale.multiplyScalar(1 + p.grow * frameSeconds);
      p.mesh.rotation.x += frameSeconds * 8;
    }
    for (const t of this.tracers) {
      if (!t.active) {
        continue;
      }
      t.life -= frameSeconds;
      (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life / 0.06) * 0.9;
      if (t.life <= 0) {
        t.active = false;
        t.line.visible = false;
      }
    }
  }

  activeParticleCount(): number {
    return this.particles.filter((p) => p.active).length;
  }

  dispose(): void {
    this.scene.remove(this.group, this.flashLight);
    this.particleGeometry.dispose();
    this.shellGeometry.dispose();
    this.shellMaterial.dispose();
    for (const m of this.materials.values()) {
      m.dispose();
    }
    for (const t of this.tracers) {
      t.line.geometry.dispose();
      (t.line.material as THREE.Material).dispose();
    }
    this.flash.geometry.dispose();
    (this.flash.material as THREE.Material).dispose();
    this.flash.removeFromParent();
  }
}
