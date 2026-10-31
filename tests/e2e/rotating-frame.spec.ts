// 回転座標系の変換（docs/plan.md §6：V-25）。ページを開かず、src/lib/rotating-frame.ts の関数を直接確かめる
import { expect, test } from "@playwright/test";
import { rotatingFrame, toFrame, type Body, type V3 } from "../../src/lib/rotating-frame";

const close = (a: V3, b: V3) => a.forEach((v, k) => expect(v).toBeCloseTo(b[k], 12));
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 質量 m1・m2、間隔 d の円軌道（角速度 ω）を、xy 平面から tilt だけ傾けた面で、位相 phase の位置に置く */
function circularPair(m1: number, m2: number, d: number, phase: number, tilt: number) {
  const omega = Math.sqrt((m1 + m2) / d ** 3);
  const place = (r: number, angle: number) => {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const flat = { p: [r * c, r * s, 0], v: [-r * omega * s, r * omega * c, 0] };
    // x 軸の周りに tilt だけ傾ける
    const tiltV = ([x, y]: number[]): V3 => [x, y * Math.cos(tilt), y * Math.sin(tilt)];
    return { p: tiltV(flat.p), v: tiltV(flat.v) };
  };
  const m = m1 + m2;
  return { omega, place, primary: { m: m1, ...place(-d * m2 / m, phase) }, secondary: { m: m2, ...place(d * m1 / m, phase) } };
}

test("V-25：円軌道のどの位相・傾きでも、伴星は +x′ 軸、主星は −x′ 軸の上に止まり、共回転する点も止まる", () => {
  for (const [m1, m2, d] of [[1 - 9.537e-4, 9.537e-4, 1], [1, 1, 2], [0.6897, 0.20255, 0.2]]) {
    const m = m1 + m2;
    for (const phase of [0, 1, 2.5, 4, 6]) {
      for (const tilt of [0, 0.5, -1.2]) {
        const pair = circularPair(m1, m2, d, phase, tilt);
        const frame = rotatingFrame(pair.primary, pair.secondary)!;
        close(toFrame(frame, pair.secondary.p), [d * m1 / m, 0, 0]);
        close(toFrame(frame, pair.primary.p), [-d * m2 / m, 0, 0]);
        expect(frame.separation).toBeCloseTo(d, 12);
        expect(frame.mu).toBeCloseTo(m2 / m, 15);
        // 2 天体の前方 60° の点（L4 の向き）は、位相によらず同じ回転座標の位置に来る
        close(toFrame(frame, pair.place(d, phase + Math.PI / 3).p), [d * Math.cos(Math.PI / 3), d * Math.sin(Math.PI / 3), 0]);
        // z′ は公転の軸（反時計回りの xy 平面の公転なら +z を x 軸の周りに傾けた向き）
        close(frame.axes[2], [0, -Math.sin(tilt), Math.cos(tilt)]);
      }
    }
  }
});

test("V-25：角運動量が 0（正面からぶつかる向き）でも、軸は正規直交で、x′ は主星から伴星への向き", () => {
  const cases: [V3, V3][] = [
    [[1, 2, 0], [3, 2, 0]],
    [[0, 0, -1], [0, 0, 2]], // x′ が静止座標系の z 軸と平行
  ];
  for (const [p1, p2] of cases) {
    const v1 = p1.map((x) => -0.3 * x) as V3; // 2 天体を結ぶ線に沿った速度だけ
    const frame = rotatingFrame({ m: 1, p: p1, v: v1 }, { m: 1, p: p2, v: [0, 0, 0] })!;
    const [x, y, z] = frame.axes;
    for (const [a, b, expected] of [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [y, z, 0], [z, x, 0]] as [V3, V3, number][]) {
      expect(dot(a, b)).toBeCloseTo(expected, 12);
    }
    const r = p2.map((v, k) => v - p1[k]) as V3;
    expect(dot(x, r)).toBeCloseTo(Math.hypot(...r), 12);
  }
  expect(rotatingFrame({ m: 1, p: [1, 1, 1], v: [0, 0, 0] }, { m: 2, p: [1, 1, 1], v: [1, 0, 0] })).toBeNull();
});

test("V-25：rotatingFrame は null か、有限で正規直交な軸を返す（極小・極大の間隔、あふれる速度、NaN）", () => {
  const cases: [string, Body, Body][] = [
    ["間隔 Number.MIN_VALUE", { m: 1, p: [0, 0, 0], v: [0, 1, 0] }, { m: 1, p: [Number.MIN_VALUE, 0, 0], v: [0, -1, 0] }],
    ["間隔 1e-300", { m: 1, p: [0, 0, 0], v: [0, 1, 0] }, { m: 1, p: [1e-300, 0, 0], v: [0, -1, 0] }],
    ["差があふれる座標", { m: 1, p: [-1e308, 0, 0], v: [0, 1, 0] }, { m: 1, p: [1e308, 0, 0], v: [0, -1, 0] }],
    ["外積があふれる速度", { m: 1, p: [0, 0, 0], v: [0, 1e300, 1e300] }, { m: 1, p: [1e10, 0, 0], v: [0, -1e300, 0] }],
    ["質量が NaN", { m: NaN, p: [0, 0, 0], v: [0, 1, 0] }, { m: 1, p: [1, 0, 0], v: [0, -1, 0] }],
    ["ふつうの入力", { m: 1, p: [0, 0, 0], v: [0, 1, 0] }, { m: 1, p: [1, 0, 0], v: [0, -1, 0] }],
  ];
  for (const [name, primary, secondary] of cases) {
    const frame = rotatingFrame(primary, secondary);
    if (!frame) continue;
    const values = [...frame.origin, ...frame.axes.flat(), frame.separation, frame.mu];
    expect(values.every(Number.isFinite), `${name}：${values}`).toBe(true);
    const [x, y, z] = frame.axes;
    for (const [a, b, expected] of [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [y, z, 0], [z, x, 0]] as [V3, V3, number][]) {
      expect(dot(a, b), name).toBeCloseTo(expected, 12);
    }
    expect(Math.sign(x[0]), `${name}：x′ は主星から伴星への向き`).toBe(1);
  }
  // ふつうの入力では null にならない
  expect(rotatingFrame(cases[5][1], cases[5][2])).not.toBeNull();
});

test("V-25：質量の合計があふれる・極小のときも、原点は 2 天体の重心、μ は伴星の質量の割合になる", () => {
  const cases: [number, number][] = [[1e308, 1e308], [1e308, 1], [1e-308, 3e-308], [Number.MIN_VALUE, Number.MIN_VALUE]];
  for (const [m1, m2] of cases) {
    const frame = rotatingFrame({ m: m1, p: [0, 0, 0], v: [0, 1, 0] }, { m: m2, p: [1, 2, 0], v: [0, -1, 0] })!;
    // 期待値は、質量の比 q = m₂ / m₁ から求める（m₁ + m₂ を直接計算しない）
    const q = m2 / m1;
    const mu = q / (1 + q);
    expect(frame.mu, `m = ${m1}, ${m2}`).toBeCloseTo(mu, 12);
    close(frame.origin, [mu, 2 * mu, 0]);
  }
});

test("V-25：どの大きさ・向きの間隔と、どんな速度（NaN・無限大・あふれる値を含む）でも、null か、有限で正規直交な軸を返す", () => {
  const sizes = [Number.MIN_VALUE, 1e-310, 1e-300, 1, 1e300, 1e308];
  const directions: V3[] = [[1, 0, 0], [1, 1, 0], [1, 1, 1], [-1, 2, -3], [0, 0, 1]];
  const velocities: V3[] = [[0, 0, 0], [0, 1, 0], [NaN, 0, 0], [0, Infinity, 0], [0, 1e300, 1e300], [1e-320, 0, 1e-320]];
  let returned = 0;
  for (const size of sizes) for (const dir of directions) for (const v of velocities) {
    const p: V3 = dir.map((d) => d * size) as V3;
    const name = `間隔 ${size}・向き ${dir}・速度 ${v}`;
    const frame = rotatingFrame({ m: 1, p: [0, 0, 0], v }, { m: 1, p, v: [0, 0, 0] });
    if (v.some((c) => !Number.isFinite(c))) {
      expect(frame, `${name}：有限でない入力は null`).toBeNull();
      continue;
    }
    if (!frame) continue;
    returned++;
    const values = [...frame.origin, ...frame.axes.flat(), frame.separation, frame.mu];
    expect(values.every(Number.isFinite), name).toBe(true);
    const [x, y, z] = frame.axes;
    for (const [a, b, expected] of [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [y, z, 0], [z, x, 0]] as [V3, V3, number][]) {
      expect(Math.abs(dot(a, b) - expected), name).toBeLessThan(1e-12);
    }
    // x′ は主星から伴星への向き
    const n = Math.hypot(...dir);
    expect(Math.abs(dot(x, dir.map((d) => d / n) as V3) - 1), name).toBeLessThan(1e-12);
  }
  // 極小の間隔でも、斜めの向きで座標系が返ること（すべて null にして条件を満たすのではない）
  expect(rotatingFrame({ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: [Number.MIN_VALUE, Number.MIN_VALUE, 0], v: [0, 0, 0] })).not.toBeNull();
  expect(returned).toBeGreaterThan(50);
});

test("V-26：z′ は相対位置 r × 相対速度 Δv の向き（大きさ 5 通り × 5 通り × 向き 3 通り × 3 通り。外積の途中があふれる・0 に落ちる大きさを含む）", () => {
  // N-07 の範囲の端（間隔 10⁻⁹、相対位置・相対速度の成分 2 × 10⁶）と、範囲の外の有限の値（計算の途中で出うる）
  const sizes = [1e-300, 1e-9, 1, 2e6, 1e200];
  const speeds = [1e-100, 1e-9, 1, 2e6, 1e200];
  const rDirs: V3[] = [[1, 0, 0], [1, 1, 0], [1, -2, 3]];
  const vDirs: V3[] = [[0, 1, 0], [0, 1, 1], [3, 1, -2]]; // どれも rDirs のどれとも平行でない
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let checked = 0;
  for (const size of sizes) for (const speed of speeds) for (const rd of rDirs) for (const vd of vDirs) {
    const name = `間隔 ${size}・速さ ${speed}・向き ${rd} と ${vd}`;
    const frame = rotatingFrame({ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: rd.map((c) => c * size) as V3, v: vd.map((c) => c * speed) as V3 });
    expect(frame, name).not.toBeNull();
    // 期待値は、大きさを掛ける前の小さな整数の向きから求める
    const c = cross(rd, vd);
    const n = Math.hypot(...c);
    frame!.axes[2].forEach((v, k) => expect(Math.abs(v - c[k] / n), name).toBeLessThan(1e-12));
    checked++;
  }
  expect(checked).toBe(5 * 5 * 3 * 3);
  // issue #16 に書いた再現の入力
  const reported: [Body, Body, V3][] = [
    [{ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: [1e200, 0, 0], v: [0, 1e200, 1e200] }, [0, -Math.SQRT1_2, Math.SQRT1_2]],
    [{ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: [1e-300, 0, 0], v: [0, 0, 1e-100] }, [0, -1, 0]],
  ];
  for (const [primary, secondary, z] of reported) close(rotatingFrame(primary, secondary)!.axes[2], z);
});

test("V-26：成分の比が極端でも（単位ベクトルにすると小さい成分が 0 に落ちる）、z′ は r × Δv の向き", () => {
  const [max, min] = [Number.MAX_VALUE, Number.MIN_VALUE];
  // [r, Δv, r × Δv の向き]。向きは、成分の積の符号から手で求めた
  const cases: [V3, V3, V3][] = [
    [[max, min, 0], [max, 0, 0], [0, 0, -1]], // PR #19 のレビュー 1 回目の入力
    [[max, 0, 0], [max, min, 0], [0, 0, 1]],
    [[max, min, min], [max, 0, 0], [0, Math.SQRT1_2, -Math.SQRT1_2]],
    [[1, 1e-300, 0], [1, 0, 0], [0, 0, -1]],
    [[1e-300, 0, 0], [1, 1e-300, 0], [0, 0, 1]],
    [[0, max, 0], [min, max, 0], [0, 0, -1]],
    [[1, 0, 0], [1, 0, 1e-320], [0, -1, 0]],
  ];
  for (const [r, dv, z] of cases) {
    const frame = rotatingFrame({ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: r, v: dv });
    expect(frame, `r = ${r}、Δv = ${dv}`).not.toBeNull();
    frame!.axes[2].forEach((v, k) => expect(Math.abs(v - z[k]), `r = ${r}、Δv = ${dv}：z′ = ${frame!.axes[2]}`).toBeLessThan(1e-12));
  }
});

/** 浮動小数点数を、整数の仮数と指数に正確に分ける（x = m × 2^e） */
function exact(x: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return biased === 0 ? [sign * fraction, -1074] : [sign * (fraction | (1n << 52n)), biased - 1075];
}
/** a × b の向きを、整数の計算で正確に求める（外積が 0 なら null） */
function exactCrossDirection(a: V3, b: V3): V3 | null {
  const [ea, eb] = [a.map(exact), b.map(exact)];
  const term = (i: number, j: number): [bigint, number] => [ea[i][0] * eb[j][0], ea[i][1] + eb[j][1]];
  const minus = ([m1, e1]: [bigint, number], [m2, e2]: [bigint, number]): [bigint, number] => {
    const e = Math.min(e1, e2);
    return [(m1 << BigInt(e1 - e)) - (m2 << BigInt(e2 - e)), e];
  };
  const c = [minus(term(1, 2), term(2, 1)), minus(term(2, 0), term(0, 2)), minus(term(0, 1), term(1, 0))];
  // 3 成分を同じ指数にそろえ、いちばん大きい成分の上位 60 ビットまでを Number にする
  const e = Math.min(...c.map(([, x]) => x));
  const aligned = c.map(([m, x]) => m << BigInt(x - e));
  const bits = Math.max(...aligned.map((m) => (m < 0n ? -m : m).toString(2).length));
  if (aligned.every((m) => m === 0n)) return null;
  const shift = BigInt(Math.max(0, bits - 60));
  const v = aligned.map((m) => Number(m >> shift)) as V3; // 負の数の右シフトは切り下げ。誤差は 2⁻⁶⁰ 程度
  const n = Math.hypot(...v);
  return v.map((x) => x / n) as V3;
}

test("V-26：成分の値 6 通り（±極大、極小、0 を含む）を r と Δv の 6 成分に入れた 46656 通りで、外積が 0 でなければ z′ は r × Δv の向き（整数で正確に求めた向きと比べる）", () => {
  const values = [Number.MAX_VALUE, -1, Number.MIN_VALUE, 0, 1e-300, -1e200];
  let checked = 0;
  let total = 0;
  const wrong: string[] = []; // 1 件ずつ expect すると遅いので、外れた入力を集めて最後に確かめる
  for (const r0 of values) for (const r1 of values) for (const r2 of values)
    for (const v0 of values) for (const v1 of values) for (const v2 of values) {
      total++;
      const [r, dv]: [V3, V3] = [[r0, r1, r2], [v0, v1, v2]];
      const frame = rotatingFrame({ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: r, v: dv });
      // 間隔が 0 か、有限の数で表せない（√3 × 極大など）なら、座標系は決まらない
      if (r.every((c) => c === 0) || !Number.isFinite(Math.hypot(...r))) {
        if (frame) wrong.push(`r = ${r}：null でない`);
        continue;
      }
      const expected = exactCrossDirection(r, dv);
      if (!expected) continue; // 外積が 0 なら、代わりの軸を使う（向きの条件はない）
      const z = frame?.axes[2];
      if (!z || Math.max(...z.map((x, k) => Math.abs(x - expected[k]))) >= 1e-12) wrong.push(`r = ${r}、Δv = ${dv}：z′ = ${z}、正しくは ${expected}`);
      checked++;
    }
  expect(wrong).toEqual([]);
  expect(total).toBe(6 ** 6);
  expect(checked).toBe(42462); // 残りは、座標系が決まらない 3672 通りと、外積が 0 の 522 通り
});

/** 隣の浮動小数点数へ k 個ずらす（x は 0 でない有限の数） */
function ulps(x: number, k: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigInt64(0, view.getBigInt64(0) + BigInt(k));
  return view.getFloat64(0);
}

test("V-26：ほぼ平行な r と Δv（Δv の各成分を r から ±2 個の浮動小数点数までずらす）でも、外積が 0 でなければ z′ は r × Δv の正確な向き", () => {
  const bases: V3[] = [[1.0000000000000557, 0.9999999999997913, 1.0000000000001008], [3, -2, 7]];
  const scales = [1e-300, 1, 1e300];
  const shifts = [-2, -1, 0, 1, 2];
  const wrong: string[] = [];
  let checked = 0;
  for (const base of bases) for (const s of scales) for (const a of shifts) for (const b of shifts) for (const c of shifts) {
    const r = base.map((x) => x * s) as V3;
    const dv = [ulps(r[0], a), ulps(r[1], b), ulps(r[2], c)] as V3;
    const expected = exactCrossDirection(r, dv);
    if (!expected) continue; // ずらさない組などは外積が 0
    const z = rotatingFrame({ m: 1, p: [0, 0, 0], v: [0, 0, 0] }, { m: 1, p: r, v: dv })?.axes[2];
    if (!z || Math.max(...z.map((x, k) => Math.abs(x - expected[k]))) >= 1e-12) wrong.push(`r = ${r}、Δv = ${dv}：z′ = ${z}、正しくは ${expected}`);
    checked++;
  }
  expect(wrong).toEqual([]);
  expect(checked).toBe(744); // 750 通りのうち、ずらさない 6 通りは外積が 0
  // PR #19 のレビュー 2 回目の入力
  const z = rotatingFrame(
    { m: 1, p: [0, 0, 0], v: [0, 0, 0] },
    { m: 1, p: [1.0000000000000557, 0.9999999999997913, 1.0000000000001008], v: [1.000000000000056, 0.9999999999997915, 1.000000000000101] },
  )!.axes[2];
  close(z, [-0.7556775518205375, 0.11004486586769663, 0.6456326859528408]);
});
