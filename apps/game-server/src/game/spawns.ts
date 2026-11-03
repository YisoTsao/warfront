import type { MapManifest, SpawnPoint } from '@frontline/map-schema';
import type { TeamName, Vec3 } from '@frontline/shared';
import type { SimWorld } from '@frontline/simulation';

export interface SpawnChoice {
  feet: Vec3;
  yaw: number;
}

/**
 * 選擇出生點：優先該隊專屬的出生點；征服模式可以選己方據點。
 * 在候選中挑離敵人最遠、且附近 1.5 m 內沒有人的位置。
 */
export function chooseSpawn(
  manifest: MapManifest,
  sim: SimWorld,
  team: TeamName,
  occupied: Array<{ position: Vec3; team: TeamName }>,
  request: { kind: 'base' } | { kind: 'objective'; position: readonly [number, number, number]; radius: number },
  random: () => number,
): SpawnChoice {
  const enemies = occupied.filter((o) => o.team !== team).map((o) => o.position);
  const blocked = (p: Vec3) => occupied.some((o) => Math.hypot(o.position.x - p.x, o.position.z - p.z) < 1.5);
  const score = (p: Vec3) => (enemies.length ? Math.min(...enemies.map((e) => Math.hypot(e.x - p.x, e.z - p.z))) : 1000) + random() * 5;

  if (request.kind === 'objective') {
    const [ox, oy, oz] = request.position;
    const centerYaw = Math.atan2(ox, oz); // 面向地圖中心
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = random() * Math.PI * 2;
      const distance = request.radius * (0.3 + random() * 0.4);
      const x = ox + Math.cos(angle) * distance;
      const z = oz + Math.sin(angle) * distance;
      const y = sim.groundHeight(x, z, oy + 30);
      if (y !== null) {
        const feet = { x, y: y + 0.05, z };
        if (!blocked(feet)) {
          return { feet, yaw: centerYaw };
        }
      }
    }
  }

  const teamSpawns = manifest.spawns.filter((s) => s.team === team);
  const candidates: SpawnPoint[] = teamSpawns.length > 0 ? teamSpawns : manifest.spawns.filter((s) => s.team === undefined);
  const pool = candidates.length > 0 ? candidates : manifest.spawns;
  const ranked = pool
    .map((s) => ({ s, feet: { x: s.position[0], y: s.position[1] + 0.05, z: s.position[2] } }))
    .filter((c) => !blocked(c.feet))
    .sort((a, b) => score(b.feet) - score(a.feet));
  const best = ranked[0] ?? { s: pool[0]!, feet: { x: pool[0]!.position[0], y: pool[0]!.position[1] + 0.05, z: pool[0]!.position[2] } };
  return { feet: best.feet, yaw: best.s.yaw };
}
