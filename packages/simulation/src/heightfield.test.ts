import { heightfieldHeightAt, parseMapCollision, type HeightfieldColliderData, type MapManifest } from '@frontline/map-schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { CharacterBody, IDLE_INPUT } from './CharacterBody';
import { initPhysics } from './rapier';
import { SimWorld } from './SimWorld';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

/** 起伏地形：用固定公式產生，方便比對。 */
function field(rows: number, cols: number): HeightfieldColliderData {
  const heights: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights.push(Math.round((Math.sin(c * 0.7) * 1.5 + Math.cos(r * 0.45) * 2 + (r * c) % 3 * 0.4) * 100) / 100);
    }
  }
  return { kind: 'heightfield', origin: [-30, -20], size: [60, 50], rows, cols, heights, layer: 'both' };
}

function manifest(): MapManifest {
  return {
    schemaVersion: 1,
    id: 'hf-test',
    name: 'hf',
    bounds: { min: [-30, -20, -20], max: [30, 40, 30] },
    killPlaneY: -30,
    environment: {
      skyColor: '#000000', fogColor: '#000000', fogNear: 1, fogFar: 2, sunDirection: [0, -1, 0], sunColor: '#ffffff',
      sunIntensity: 1, hemisphereSky: '#ffffff', hemisphereGround: '#000000', hemisphereIntensity: 1,
    },
    chunks: [],
    collision: 'collision.json',
    spawns: [{ id: 's', position: [0, 0, 0], yaw: 0 }],
    objectives: [],
    restrictedAreas: [],
    waterVolumes: [],
  };
}

describe('高度場碰撞', () => {
  it('Rapier 射線命中的高度與 heightfieldHeightAt 一致（方向與三角切分相同）', () => {
    const hf = field(21, 31);
    const sim = new SimWorld(manifest(), parseMapCollision({ schemaVersion: 1, colliders: [hf] }), DT);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 400; i++) {
      const x = -30 + rnd() * 60;
      const z = -20 + rnd() * 50;
      const expected = heightfieldHeightAt(hf, x, z);
      expect(expected).not.toBeNull();
      expect(sim.groundHeight(x, z, 50)).toBeCloseTo(expected!, 3);
    }
    expect(heightfieldHeightAt(hf, -31, 0)).toBeNull();
    sim.dispose();
  });

  it('高度數量不符時拒絕', () => {
    const hf = field(4, 4);
    expect(() => parseMapCollision({ schemaVersion: 1, colliders: [{ ...hf, heights: hf.heights.slice(1) }] })).toThrow(/rows × cols/);
  });

  it('角色可以站在高度場上並走動', () => {
    const hf = field(21, 31);
    const sim = new SimWorld(manifest(), parseMapCollision({ schemaVersion: 1, colliders: [hf] }), DT);
    const ground = heightfieldHeightAt(hf, 0, 5)!;
    const body = new CharacterBody(sim, { x: 0, y: ground + 0.5, z: 5 });
    for (let i = 0; i < 40; i++) {
      body.step(IDLE_INPUT, 0, DT);
      sim.step();
    }
    expect(body.isGrounded).toBe(true);
    for (let i = 0; i < 120; i++) {
      body.step({ ...IDLE_INPUT, move: { forward: 1, right: 0, sprint: false } }, 0, DT);
      sim.step();
    }
    const feet = body.snapshot().feet;
    expect(feet.z).toBeLessThan(0);
    expect(feet.y).toBeGreaterThan(heightfieldHeightAt(hf, feet.x, feet.z)! - 0.1);
    sim.dispose();
  });
});
