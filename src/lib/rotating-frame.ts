// 回転座標系（C-03）。主星と伴星を結ぶ線が止まって見える座標系に、位置を移す。
// 原点は 2 天体の重心、x′ 軸は主星から伴星への向き、z′ 軸は 2 天体の相対運動の角運動量の向き、y′ = z′ × x′。
// その時刻の 2 天体の位置と速度から決めるので、楕円軌道では間隔が変わる（座標は伸び縮みさせない）。

export type V3 = [number, number, number];

export interface Body {
  m: number;
  p: V3;
  v: V3;
}

export interface Frame {
  origin: V3;
  /** x′、y′、z′ 軸の単位ベクトル（静止座標系での向き） */
  axes: [V3, V3, V3];
  /** 2 天体の間隔 */
  separation: number;
  /** 伴星の質量の割合 μ = m₂ / (m₁ + m₂) */
  mu: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const finite = (values: number[]) => values.every(Number.isFinite);
const largest = (a: V3) => Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
/** 長さ。いちばん大きい成分で割ってから求める（極小の成分の 2 乗は 0 や非正規化数に落ち、極大の成分の 2 乗はあふれるため） */
const norm = (a: V3): number => {
  const k = largest(a);
  return k > 0 && Number.isFinite(k) ? k * Math.hypot(a[0] / k, a[1] / k, a[2] / k) : k;
};
/** 単位ベクトル。いちばん大きい成分で割ってから長さで割る。長さが 0 か、結果が有限でなければ null */
const unit = (a: V3): V3 | null => {
  const k = largest(a);
  if (!(k > 0) || !Number.isFinite(k)) return null;
  const b: V3 = [a[0] / k, a[1] / k, a[2] / k];
  const n = Math.hypot(...b);
  const u: V3 = [b[0] / n, b[1] / n, b[2] / n];
  return finite(u) ? u : null;
};
/** x = m × 2^e に分ける（|m| は 0.5 以上 1 未満。x = 0 なら [0, 0]）。x は有限 */
const frexp = (x: number): [number, number] => {
  if (x === 0) return [0, 0];
  let e = Math.floor(Math.log2(Math.abs(x))) + 1;
  // 2^−e は、e が極端だとあふれたり 0 に落ちたりするので、2 回に分けて掛ける
  const h = Math.trunc(e / 2);
  let m = x * 2 ** -h * 2 ** -(e - h);
  while (Math.abs(m) >= 1) [m, e] = [m / 2, e + 1];
  while (Math.abs(m) < 0.5) [m, e] = [m * 2, e - 1];
  return [m, e];
};
/** x を、整数 n と指数 e に正確に分ける（x = n × 2^e。仮数は 53 ビットまでなので、m × 2⁵³ は整数） */
const toInteger = (x: number): [bigint, number] => {
  const [m, e] = frexp(x);
  return [BigInt(m * 2 ** 53), e - 53];
};
/** 整数と指数で表した 2 つの積の差を、指数を小さいほうにそろえて正確に求める */
const minus = ([n1, e1]: [bigint, number], [n2, e2]: [bigint, number]): [bigint, number] => {
  const e = Math.min(e1, e2);
  return [(n1 << BigInt(e1 - e)) - (n2 << BigInt(e2 - e)), e];
};
/** a × b の向き（単位ベクトル）。a と b は有限。外積を整数（BigInt）で正確に求めてから、上位の 60 ビットで向きを決める。
 * 浮動小数点数で求めると、途中があふれる・小さい成分が 0 に落ちる・ほぼ平行なときに積の丸めで打ち消し合いの残りが消える。
 * 外積が 0 なら null */
const crossDirection = (a: V3, b: V3): V3 | null => {
  const [ia, ib] = [a.map(toInteger), b.map(toInteger)];
  const term = (i: number, j: number): [bigint, number] => [ia[i][0] * ib[j][0], ia[i][1] + ib[j][1]];
  const c = [minus(term(1, 2), term(2, 1)), minus(term(2, 0), term(0, 2)), minus(term(0, 1), term(1, 0))];
  const e = Math.min(...c.map(([, x]) => x));
  const aligned = c.map(([n, x]) => n << BigInt(x - e));
  if (aligned.every((n) => n === 0n)) return null;
  const bits = Math.max(...aligned.map((n) => (n < 0n ? -n : n).toString(2).length));
  const shift = BigInt(Math.max(0, bits - 60));
  return unit(aligned.map((n) => Number(n >> shift)) as V3);
};
/** 3 本の軸が正規直交か（許容 1e-12） */
const orthonormal = ([x, y, z]: [V3, V3, V3]) =>
  [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [y, z, 0], [z, x, 0]].every(
    ([a, b, expected]) => Math.abs(dot(a as V3, b as V3) - (expected as number)) < 1e-12,
  );

/** 主星と伴星から回転座標系を作る。返すのは、null か、有限で正規直交な軸を持つ座標系だけ。
 * 座標系が決まらないとき（入力に有限でない値がある、2 天体が重なる、値があふれる）は null */
export function rotatingFrame(primary: Body, secondary: Body): Frame | null {
  if (![primary, secondary].every((b) => finite([b.m, ...b.p, ...b.v]))) return null;
  // 質量の合計や、質量と位置の積は、あふれたり 0 に落ちたりする。大きいほうの質量で割った比から μ を求め、
  // 原点（2 天体の重心）は主星から伴星へ μ だけ進んだ点として求める
  const big = Math.max(primary.m, secondary.m);
  const [w1, w2] = [primary.m / big, secondary.m / big];
  const mu = w2 / (w1 + w2);
  const r = sub(secondary.p, primary.p);
  const origin = [0, 1, 2].map((k) => primary.p[k] + mu * (secondary.p[k] - primary.p[k])) as V3;
  const x = unit(r);
  if (!x) return null;
  // z′ は、2 天体の相対運動の角運動量 r × Δv の向き（crossDirection。docs/plan.md §3：N-08）。
  // 角運動量が 0（Δv が 0 か r と平行）か、Δv があふれるときは、静止座標系の z 軸（それも x′ と平行なら y 軸）の、
  // x′ に垂直な成分を使う
  const dv = sub(secondary.v, primary.v);
  const l = finite(dv) ? crossDirection(r, dv) : null;
  const candidates: V3[] = [...(l ? [l] : []), [0, 0, 1], [0, 1, 0]];
  let z: V3 | null = null;
  for (const c of candidates) {
    const w = sub(c, scale(x, dot(c, x)));
    if (norm(w) > 1e-9 * norm(c)) z = unit(w);
    if (z) break;
  }
  if (!z) return null;
  const frame: Frame = { origin, axes: [x, cross(z, x), z], separation: norm(r), mu };
  // 返す値の条件（すべて有限、軸は正規直交）を、ここでまとめて確かめる。途中の計算で条件が崩れる入力があっても、
  // 崩れた座標系は返さない
  return finite([...frame.origin, ...frame.axes.flat(), frame.separation, frame.mu]) && orthonormal(frame.axes) ? frame : null;
}

/** 静止座標系の位置を、回転座標系の (x′, y′, z′) に移す */
export function toFrame(frame: Frame, p: V3): V3 {
  const d = sub(p, frame.origin);
  return frame.axes.map((a) => dot(d, a)) as V3;
}
