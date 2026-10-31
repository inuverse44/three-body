// 軌跡の点の記録（C-03、issue #9）。点は、描画の頻度と再生の速さによらず、決まった時間の間隔で記録する
// （1 回の描画で 1 点だけ記録すると、速く再生したときに周期の短い軌道が角ばるため）。

/** 軌跡の点を記録する時間の間隔（単位時間）。再生の速さ 1・毎秒 60 回の描画のときの 1 回分と同じ細かさ */
export const TRAIL_DT = 1 / 60;
/** 軌跡の点のうち、時刻が入っている番号 */
export const TIME = 3;
/** 記録できる時刻の大きさの上限。1/60 の倍数の番号（6 × 10¹⁰ まで）を整数として正確に数え、
 * 隣の倍数との差（1/60）が時刻の丸め（10⁹ で 1.2 × 10⁻⁷）より十分大きい範囲。速さ 10 で再生し続けても約 3 年かかる */
export const TIME_LIMIT = 1e9;
/** 1 回の呼び出しで記録する時刻の数の上限（1 回の描画で進める時間は 0.1 秒 × 速さ 10 = 1 単位時間、61 個まで） */
export const MAX_TIMES = 10000;
/** trimTrail の点の数の上限の下限 */
export const MIN_MAX_POINTS = 12;

/**
 * 時刻 from から to まで進めるときに、軌跡の点を記録する時刻：(from, to) にある TRAIL_DT の整数倍と、最後に to。
 * 入力：from と to は有限で、絶対値が TIME_LIMIT 以下。記録する時刻（to を含む）は MAX_TIMES 個以下になること。
 *   範囲の外は RangeError（理由つき）。
 * 出力：to ≤ from なら空。そうでなければ、昇順で、どれも from より大きく to 以下、最後は to、数は MAX_TIMES 以下。
 *   from と最初の時刻の差、隣どうしの差は、TRAIL_DT + 2⁻⁴⁰ × max(1, |to|) 以下（k × TRAIL_DT の丸めの分だけ超えうる）
 */
export function recordTimes(from: number, to: number): number[] {
  if (![from, to].every((t) => Number.isFinite(t) && Math.abs(t) <= TIME_LIMIT)) {
    throw new RangeError(`recordTimes：時刻は有限で、絶対値が ${TIME_LIMIT} 以下`);
  }
  if (!(to > from)) return [];
  const tooMany = () => new RangeError(`recordTimes：1 回に記録する時刻は ${MAX_TIMES} 個まで`);
  // (from, to) の倍数の番号は first〜last − 1 に入る（割り算の丸めで、1 つ外の番号の倍数が中に入ることもあるので、
  // 両端の番号も調べる）。番号の差はループの回数を抑えるためだけに使い、受け付けるかは実際の数で決める
  const first = Math.floor(from / TRAIL_DT);
  const last = Math.ceil(to / TRAIL_DT);
  if (last - first > MAX_TIMES + 3) throw tooMany();
  const times: number[] = [];
  for (let k = first - 1; k <= last; k++) {
    const t = k * TRAIL_DT;
    // 丸めで from 以下・to 以上になる倍数は飛ばす
    if (t > from && t < to) times.push(t);
  }
  times.push(to);
  if (times.length > MAX_TIMES) throw tooMany();
  return times;
}

const drawable = (p: number[]) => p.every(Number.isFinite);

/**
 * 軌跡の点（時刻の昇順、1 つ以上。各点の TIME 番目が時刻）から、古い点を捨てる。配列をその場で書き換える。
 * 入力：length は残す時間の長さ（0 以上。Infinity は「すべて残す」）、max は点の数の上限（MIN_MAX_POINTS 以上の整数）。
 *   範囲の外は RangeError（理由つき）。
 * 出力：いちばん新しい点は残す。ほかの点は、いちばん新しい点との時刻の差が length 以下のものだけ残す。
 *   残った点が max を超えたら、q = ⌊max / 4⌋ として、新しい方の max − 2q − 1 個（max / 2 − 1 個以上）は記録したときの
 *   間隔のまま残し、それより古い部分を間引く：描ける点は、いちばん古い点から前へ、時刻の間隔が
 *   gap = 古い部分の時間 / (q − 1) 以上になるように選ぶ（q 個以下。どこも同じくらいの細かさで全体の形が残る）。
 *   描けない点（NaN を含む。線を切る印）は、続いたものを 1 点にまとめて残す（q + 1 個以下）。
 *   そのため、結果は max 以下で、時刻の昇順。いちばん古い点は残る。もとの 2 つの描ける点の間に描けない点があれば、
 *   残った 2 つの描ける点の間にも描けない点が残る（線が切れたまま）
 */
export function trimTrail(points: number[][], length: number, max: number): void {
  if (points.length === 0) throw new RangeError("trimTrail：点が 1 つ以上必要");
  if (!(length >= 0)) throw new RangeError("trimTrail：長さは 0 以上");
  if (!Number.isInteger(max) || max < MIN_MAX_POINTS) throw new RangeError(`trimTrail：上限は ${MIN_MAX_POINTS} 以上の整数`);
  const newest = points[points.length - 1][TIME];
  let drop = 0;
  while (drop < points.length - 1 && newest - points[drop][TIME] > length) drop++;
  if (drop > 0) points.splice(0, drop);
  if (points.length <= max) return;
  const q = Math.floor(max / 4);
  const split = points.length - (max - 2 * q - 1);
  const gap = (points[split - 1][TIME] - points[0][TIME]) / (q - 1);
  const older: number[][] = [];
  let lastKept = -Infinity;
  for (let k = 0; k < split; k++) {
    const p = points[k];
    if (!drawable(p)) {
      // 続いた描けない点は 1 点にまとめる（直前に残した点が描けない点なら足さない）
      if (older.length === 0 || drawable(older[older.length - 1])) older.push(p);
    } else if (k === 0 || p[TIME] - lastKept >= gap) {
      older.push(p);
      lastKept = p[TIME];
    }
  }
  points.splice(0, split, ...older);
}
