/** 產生範例地圖用的簡單幾何（位置、法線、索引、頂點色）。 */
export interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
  colors?: number[];
}

export function emptyMesh(): MeshData {
  return { positions: [], normals: [], indices: [] };
}

export function merge(target: MeshData, source: MeshData, offset: [number, number, number] = [0, 0, 0]): MeshData {
  const base = target.positions.length / 3;
  for (let i = 0; i < source.positions.length; i += 3) {
    target.positions.push(source.positions[i]! + offset[0], source.positions[i + 1]! + offset[1], source.positions[i + 2]! + offset[2]);
  }
  target.normals.push(...source.normals);
  for (const index of source.indices) {
    target.indices.push(index + base);
  }
  if (source.colors) {
    target.colors ??= [];
    target.colors.push(...source.colors);
  }
  return target;
}

/** 以中心為原點的方塊，每面獨立頂點（平面法線）。 */
export function box(w: number, h: number, d: number): MeshData {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const faces: Array<{ n: [number, number, number]; v: Array<[number, number, number]> }> = [
    { n: [1, 0, 0], v: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { n: [-1, 0, 0], v: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { n: [0, 1, 0], v: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
    { n: [0, 0, 1], v: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { n: [0, 0, -1], v: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
  ];
  const mesh = emptyMesh();
  for (const face of faces) {
    const base = mesh.positions.length / 3;
    for (const v of face.v) {
      mesh.positions.push(...v);
      mesh.normals.push(...face.n);
    }
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return mesh;
}

/** 底部在 y=0 的圓錐（或截頭圓錐），側面平滑法線。 */
export function cone(radiusBottom: number, radiusTop: number, height: number, segments: number, yOffset = 0): MeshData {
  const mesh = emptyMesh();
  const slope = (radiusBottom - radiusTop) / height;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const nl = Math.hypot(1, slope);
    mesh.positions.push(c * radiusBottom, yOffset, s * radiusBottom, c * radiusTop, yOffset + height, s * radiusTop);
    mesh.normals.push(c / nl, slope / nl, s / nl, c / nl, slope / nl, s / nl);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    mesh.indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  // 底面
  const center = mesh.positions.length / 3;
  mesh.positions.push(0, yOffset, 0);
  mesh.normals.push(0, -1, 0);
  for (let i = 0; i < segments; i++) {
    mesh.indices.push(center, i * 2, (i + 1) * 2);
  }
  return mesh;
}

/** 變形的二十面體，當作岩石。 */
export function rock(radius: number, seed: number): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const scaled = verts.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    const k = (radius * (0.75 + rand() * 0.5)) / l;
    return [x * k, y * k * 0.7, z * k] as [number, number, number];
  });
  const mesh = emptyMesh();
  for (const [a, b, c] of faces) {
    const pa = scaled[a!]!;
    const pb = scaled[b!]!;
    const pc = scaled[c!]!;
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    const base = mesh.positions.length / 3;
    for (const p of [pa, pb, pc]) {
      mesh.positions.push(...p);
      mesh.normals.push(n[0]! / nl, n[1]! / nl, n[2]! / nl);
    }
    mesh.indices.push(base, base + 1, base + 2);
  }
  return mesh;
}
