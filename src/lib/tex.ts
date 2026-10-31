// 数式（TeX）をビルドの時に MathML へ変換する。ブラウザのスクリプトも外部のフォントも使わない。
// Temml は一部の要素に style 属性を付けるが、CSP（style 属性は許可しない）に阻まれるので、既知のものをクラスに置き換える。
// 知らない style が出てきたらビルドを止める（見た目が黙って崩れないように）。
import temml from "temml";

const STYLE_TO_CLASS: Record<string, string> = {
  "display:block math;": "tml-sty-block",
  "math-depth:0;": "tml-sty-depth0",
  "padding-left:0em;padding-right:0em;": "tml-sty-pad00",
  "padding-left:1em;padding-right:0em;": "tml-sty-pad10",
  "margin-left:-0.1667em;": "tml-sty-negthin",
  // aligned の列に付く。余白以外の値は Temml の内部の値がそのまま出ているだけで、CSS としては意味がない
  "level:0;color:undefined;font:;font-family:;font-size:1;font-weight:;font-shape:;max-size:Infinity,Infinity;padding-left:0em;padding-right:0em;":
    "tml-sty-pad00",
};

export function tex(source: string, display = false): string {
  const html = temml.renderToString(source, { displayMode: display, throwOnError: true });
  const converted = html.replace(/(<[a-z]+\b[^>]*?)\sstyle="([^"]*)"([^>]*>)/g, (_match, start: string, style: string, end: string) => {
    const cls = STYLE_TO_CLASS[style];
    if (!cls) throw new Error(`数式の変換で、知らない style 属性が出てきました：${style}（src/lib/tex.ts に追加してください）`);
    if (/\sclass="/.test(start + end)) {
      return (start + end).replace(/\sclass="([^"]*)"/, ` class="$1 ${cls}"`);
    }
    return `${start} class="${cls}"${end}`;
  });
  // 別行立ての数式は、狭い画面では横にスクロールする。キーボードでも移動できるように、フォーカスできる領域で包む（axe：scrollable-region-focusable）
  return display ? `<div class="math-scroll" tabindex="0" role="group" aria-label="数式">${converted}</div>` : converted;
}
