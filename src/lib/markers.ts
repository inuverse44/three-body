// 天体の形（色だけに頼らない）。8 つの天体それぞれに、色・番号・形を割り当てる。
// 画面の凡例（Astro の SVG）と、キャンバスの描画（simulator.ts）が同じ形を使う。
/** 正多角形の辺の数と回転（ラジアン）。辺の数 0 は円 */
const SHAPES: readonly [number, number][] = [
  [0, 0], // 円
  [4, Math.PI / 4], // 正方形
  [3, -Math.PI / 2], // 上向きの三角形
  [4, 0], // ひし形
  [5, -Math.PI / 2], // 五角形
  [3, Math.PI / 2], // 下向きの三角形
  [6, 0], // 六角形
  [8, Math.PI / 8], // 八角形
];

/** i 番目の天体の形の頂点（半径 r、原点が中心）。円のときは null */
export function markerPoints(i: number, r: number): [number, number][] | null {
  const [sides, rotation] = SHAPES[i % SHAPES.length];
  if (sides === 0) return null;
  // 正方形は辺が軸に平行になるように、同じ面積感に見えるよう半径を少し大きくする
  const scale = sides === 4 && rotation !== 0 ? 1.1 : 1;
  return Array.from({ length: sides }, (_, k) => {
    const a = rotation + (2 * Math.PI * k) / sides;
    return [r * scale * Math.cos(a), r * scale * Math.sin(a)];
  });
}
