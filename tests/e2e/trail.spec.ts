// 軌跡の点の記録（src/lib/trail.ts、V-29）。ブラウザを使わずに確かめる
import { expect, test } from "@playwright/test";
import { MAX_TIMES, recordTimes, TIME, TIME_LIMIT, TRAIL_DT, trimTrail } from "../../src/lib/trail";

/** recordTimes の差の上限：TRAIL_DT + 2⁻⁴⁰ × max(1, |to|) */
const gapBound = (to: number) => TRAIL_DT + 2 ** -40 * Math.max(1, Math.abs(to));

/** recordTimes の出力の条件に合わない理由（合えば空） */
function recordProblems(from: number, to: number, times: number[]): string[] {
  const bad: string[] = [];
  const where = `from=${from} to=${to}`;
  if (times.length === 0 || times.at(-1) !== to) bad.push(`${where}：最後が to でない`);
  if (times.length > MAX_TIMES) bad.push(`${where}：時刻が ${times.length} 個`);
  let prev = from;
  for (const t of times) {
    if (!(t > prev)) bad.push(`${where}：昇順でない（${prev} → ${t}）`);
    if (t - prev > gapBound(to)) bad.push(`${where}：差 ${t - prev} が上限を超える`);
    prev = t;
  }
  return bad;
}

test("V-29：recordTimes は (from, to] の昇順の時刻を返し、最後は to、どの差も 1/60（＋丸め）以下", () => {
  // 始まり：0、ちょうどの倍数とその隣の浮動小数点数、半端な値、10⁶ 台、負、範囲の両端の近く
  const starts = [0, 0.05, 3 * TRAIL_DT, 3 * TRAIL_DT * (1 - Number.EPSILON), 3 * TRAIL_DT * (1 + Number.EPSILON), 123.456, 1e6 + 0.3, -2.5, -TIME_LIMIT, TIME_LIMIT - 10];
  // 1 回に進める時間：極小、1/120、1/60、半端、1 回の描画の最大（0.1 秒 × 速さ 10）、その 10 倍
  const spans = [1e-9, TRAIL_DT / 2, TRAIL_DT, 0.1234, 1, 10];
  const bad: string[] = [];
  for (const from of starts) {
    for (const span of spans) {
      const to = from + span;
      const times = recordTimes(from, to);
      // 時刻が大きいと、極小の長さは丸めで消える（to = from）。そのときは空
      if (to === from) {
        if (times.length > 0) bad.push(`from=${from} span=${span}：進まないのに時刻がある`);
        continue;
      }
      bad.push(...recordProblems(from, to, times));
      if (times.length > Math.ceil(span / TRAIL_DT) + 1) bad.push(`from=${from} span=${span}：時刻が多すぎる（${times.length}）`);
    }
  }
  expect(bad).toEqual([]);
  // 進まない・戻るときは空
  expect(recordTimes(5, 5)).toEqual([]);
  expect(recordTimes(5, 4.9)).toEqual([]);
});

test("V-29：recordTimes は範囲の外（有限でない時刻、絶対値が 10⁹ を超える時刻）を理由つきで拒否し、止まらなくなる大きな時刻（PR #30 のレビュー）も拒否する", () => {
  for (const [from, to] of [
    [NaN, 1],
    [0, Infinity],
    [-Infinity, 0],
    [TIME_LIMIT, TIME_LIMIT * (1 + Number.EPSILON)],
    [-TIME_LIMIT * (1 + Number.EPSILON), 0],
    [1e15, 1e15 + 10],
  ]) {
    expect(() => recordTimes(from, to), `${from}, ${to}`).toThrow(RangeError);
  }
});

/** x から浮動小数点数で n 個隣の値（x は有限で 0 でない。n が正なら大きい側、負なら小さい側へ） */
function nextFloat(x: number, n: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  // 正の数はビット列を 1 増やすと大きくなり、負の数は小さくなる
  view.setBigInt64(0, view.getBigInt64(0) + BigInt(x > 0 ? n : -n));
  return view.getFloat64(0);
}

/** 記録するはずの時刻の数の参照値：(from, to) にある k / 60 の数（番号を広めに取って 1 つずつ数える）と、最後の to */
function referenceCount(from: number, to: number): number {
  let count = 1;
  for (let k = Math.floor(from / TRAIL_DT) - 5; k <= Math.ceil(to / TRAIL_DT) + 5; k++) {
    const t = k * TRAIL_DT;
    if (t > from && t < to) count++;
  }
  return count;
}

test("V-29：recordTimes は、記録する時刻（最後の to を含む）が 10000 個を超えるときだけ拒否し、受け付けたときは参照値と同じ数（10000 個以下）。時刻の大きさによらない", () => {
  const bad: string[] = [];
  let accepted = 0;
  let rejected = 0;
  const check = (from: number, to: number) => {
    const reference = referenceCount(from, to);
    let times: number[];
    try {
      times = recordTimes(from, to);
    } catch (error) {
      if (!(error instanceof RangeError)) bad.push(`from=${from} to=${to}：RangeError でない`);
      if (reference <= MAX_TIMES) bad.push(`from=${from} to=${to}：${reference} 個なのに拒否した`);
      rejected++;
      return;
    }
    accepted++;
    bad.push(...recordProblems(from, to, times));
    if (times.length !== reference) bad.push(`from=${from} to=${to}：${times.length} 個（参照値 ${reference}）`);
  };
  // 時刻の大きさ（割り算と掛け算の丸めの向きがずれる大きな時刻、負を含む）× 始まりのずれ（倍数ちょうど、半分、
  // 倍数の隣の浮動小数点数 2 つ）× 個数 9998〜10001 × 端数 3 通り
  for (const base of [0, 1e6, -1e6, 1e8, -1e8, TIME_LIMIT - 200, -(TIME_LIMIT - 200)]) {
    const k0 = Math.round(base / TRAIL_DT);
    for (const offset of [0, 0.5, -(2 ** -30), 2 ** -30]) {
      for (const steps of [9998, 9999, 10000, 10001]) {
        for (const extra of [0, 0.5, 1 - 2 ** -30]) check((k0 + offset) * TRAIL_DT, (k0 + offset + steps + extra) * TRAIL_DT);
      }
    }
  }
  // 両端を倍数の近くに置く：k / 60 から浮動小数点数で −3〜+3 個ずらした始まりと、(k + 個数) / 60 から −3〜+3 個ずらした
  // 終わり（割り算と掛け算の丸めの向きがずれるのは、端が倍数のすぐ近くにあるとき）。時刻の大きさは 4 通り
  for (const base of [1e8, -1e8, 666887199.7, TIME_LIMIT - 200]) {
    const k0 = Math.round(base / TRAIL_DT);
    for (const steps of [10000, 10001]) {
      for (let i = -3; i <= 3; i++) {
        for (let j = -3; j <= 3; j++) check(nextFloat(k0 * TRAIL_DT, i), nextFloat((k0 + steps) * TRAIL_DT, j));
      }
    }
  }
  // PR #30 のレビュー 2 回目の入力（10001 個を返した区間と、10000 個なのに拒否した区間）
  check(666887199.6999999, 666887366.3500001);
  check(142630858.66666666, 142631025.3166667);
  expect(bad).toEqual([]);
  // 格子が両側を通ったこと
  expect(accepted).toBeGreaterThan(0);
  expect(rejected).toBeGreaterThan(0);
  expect(recordTimes(0.5 * TRAIL_DT, 9998.5 * TRAIL_DT).length).toBe(9999);
  expect(() => recordTimes(0.5 * TRAIL_DT, 10000.5 * TRAIL_DT)).toThrow(RangeError);
});

/** 時刻 t の点（位置は円の上。drawable が false なら回転座標系の位置を NaN にする） */
const point = (t: number, drawable = true) => [Math.cos(t), Math.sin(t), 0, t, ...(drawable ? [Math.cos(t), 0, 0] : [NaN, NaN, NaN])];
const isDrawable = (p: number[]) => p.every(Number.isFinite);

/** 描画ごとに 1 単位時間ずつ進め、recordTimes の時刻で点を足して trimTrail を呼ぶ。記録したすべての点も返す */
function play(until: number, length: number, max: number, drawable: (t: number) => boolean = () => true) {
  const points = [point(0, drawable(0))];
  const recorded = [points[0]];
  for (let from = 0; from < until; from += 1) {
    for (const t of recordTimes(from, from + 1)) {
      points.push(point(t, drawable(t)));
      recorded.push(points.at(-1)!);
    }
    trimTrail(points, length, max);
  }
  return { points, recorded };
}

/** trimTrail の出力の条件（上限、昇順、いちばん古い点、線の切れ目）に合わない理由 */
function trimProblems(points: number[][], recorded: number[][], max: number): string[] {
  const bad: string[] = [];
  if (points.length > max) bad.push(`点が ${points.length} 個`);
  if (points[0] !== recorded[0]) bad.push("いちばん古い点がない");
  if (points.at(-1) !== recorded.at(-1)) bad.push("いちばん新しい点がない");
  for (let k = 1; k < points.length; k++) if (!(points[k][TIME] > points[k - 1][TIME])) bad.push(`${k} 番目が昇順でない`);
  // 残った隣どうしの描ける点の間に、もとは描けない点があったなら、残った点の間にも描けない点がある
  const index = new Map(recorded.map((p, k) => [p, k]));
  let previous = -1;
  for (const p of points) {
    if (!isDrawable(p)) {
      previous = -1;
      continue;
    }
    const k = index.get(p)!;
    if (previous >= 0 && recorded.slice(previous + 1, k).some((r) => !isDrawable(r))) bad.push(`時刻 ${p[TIME]} の前で線の切れ目が消えた`);
    previous = k;
  }
  return bad;
}

test("V-29：trimTrail は、選んだ長さ（時間）の点だけを残し、いちばん新しい点は必ず残す", () => {
  for (const length of [0, 0.5, 2, 20]) {
    const { points } = play(50, length, 20000);
    const newest = points.at(-1)![TIME];
    expect(newest).toBe(50);
    expect(points.every((p) => newest - p[TIME] <= length), `長さ ${length}`).toBe(true);
    // 長さの分の点がそろっている（記録の間隔は 1/60）
    expect(points.length, `長さ ${length}`).toBeGreaterThanOrEqual(Math.floor(length / TRAIL_DT));
  }
});

test("V-29：「すべて残す」で点の数が上限を超えると、古い部分を同じくらいの細かさに間引く。数は上限以下、時刻は昇順、いちばん古い点は残り、新しい max / 2 − 1 個は記録の間隔のまま", () => {
  const max = 2000;
  const { points, recorded } = play(1000, Infinity, max);
  expect(trimProblems(points, recorded, max)).toEqual([]);
  expect(points.at(-1)![TIME]).toBe(1000);
  const gaps = points.slice(1).map((p, k) => p[TIME] - points[k][TIME]);
  expect(gaps.slice(-(max / 2 - 2)).filter((g) => g > gapBound(1000)), "新しい部分の差").toEqual([]);
  // 古い部分（時間 約 983）は 500 点以下で表すので、間隔は約 2。前から選ぶ間引きを重ねても 2 倍ほどにとどまる。
  // 上限は 4 倍の 8 で確かめる。時刻 0〜100 にも点が残る（全体の形が残る）
  expect(gaps.slice(0, -(max / 2)).filter((g) => g > 8), "古い部分の差").toEqual([]);
  expect(points.filter((p) => p[TIME] < 100).length, "時刻 0〜100 の点").toBeGreaterThanOrEqual(12);
});

test("V-29：描けない点（NaN、線を切る印）があっても、上限以下で、いちばん古い点と線の切れ目は残る", () => {
  // 描けない区間が 0.3 ごとに入る、ほとんど描けない、すべて描けない、の 3 通り
  const patterns: [string, (t: number) => boolean][] = [
    ["0.9 ごとに 0.3 だけ描けない", (t) => Math.floor(t / 0.3) % 3 !== 0],
    ["ほとんど描けない", (t) => Math.floor(t / TRAIL_DT + 0.5) % 7 === 0],
    ["すべて描けない", () => false],
  ];
  for (const [name, drawable] of patterns) {
    for (const max of [12, 13, 200]) {
      const { points, recorded } = play(60, Infinity, max, drawable);
      expect(trimProblems(points, recorded, max), `${name}、上限 ${max}`).toEqual([]);
    }
  }
  // PR #30 のレビューの入力：時刻 0〜20 の描けない点 21 個（上限は 12 以上なので 12 で）
  const all = Array.from({ length: 21 }, (_, t) => point(t, false));
  const recorded = [...all];
  trimTrail(all, Infinity, 12);
  expect(trimProblems(all, recorded, 12)).toEqual([]);
});

test("V-29：trimTrail は範囲の外（点がない、長さが負や NaN、上限が 12 未満や整数でない）を理由つきで拒否する", () => {
  expect(() => trimTrail([], 1, 100)).toThrow(RangeError);
  for (const length of [-1, NaN]) expect(() => trimTrail([point(0)], length, 100), `長さ ${length}`).toThrow(RangeError);
  for (const max of [11, 12.5, NaN]) expect(() => trimTrail([point(0)], 1, max), `上限 ${max}`).toThrow(RangeError);
});
