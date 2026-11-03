/** map-build 用的最小矩陣工具（glTF 欄主序 4x4）。 */
export type Mat4 = ArrayLike<number>;
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export function transformPoint(m: Mat4, p: readonly number[]): V3 {
  const x = p[0]!;
  const y = p[1]!;
  const z = p[2]!;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

export function column(m: Mat4, i: number): V3 {
  return [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
}

export const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);

/** 由（已正規化的）旋轉矩陣三個軸求四元數。 */
export function quatFromAxes(xAxis: V3, yAxis: V3, zAxis: V3): Q4 {
  const m00 = xAxis[0];
  const m10 = xAxis[1];
  const m20 = xAxis[2];
  const m01 = yAxis[0];
  const m11 = yAxis[1];
  const m21 = yAxis[2];
  const m02 = zAxis[0];
  const m12 = zAxis[1];
  const m22 = zAxis[2];
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

/** 四元數旋轉向量 */
export function rotate(q: readonly number[], v: V3): V3 {
  const [qx, qy, qz, qw] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const ix = qw * v[0] + qy * v[2] - qz * v[1];
  const iy = qw * v[1] + qz * v[0] - qx * v[2];
  const iz = qw * v[2] + qx * v[1] - qy * v[0];
  const iw = -qx * v[0] - qy * v[1] - qz * v[2];
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

export const round = (v: number, digits = 3) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export interface Box3 {
  min: V3;
  max: V3;
}

export function emptyBox(): Box3 {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function expand(box: Box3, p: readonly number[]): void {
  for (let i = 0; i < 3; i++) {
    box.min[i] = Math.min(box.min[i]!, p[i]!);
    box.max[i] = Math.max(box.max[i]!, p[i]!);
  }
}

export function unionBox(a: Box3, b: Box3): Box3 {
  const r = emptyBox();
  for (const box of [a, b]) {
    if (!isEmptyBox(box)) {
      expand(r, box.min);
      expand(r, box.max);
    }
  }
  return r;
}

export function isEmptyBox(b: Box3): boolean {
  return b.min[0] > b.max[0];
}
