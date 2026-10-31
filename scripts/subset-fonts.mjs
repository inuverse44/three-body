// フォントを、ページで使う文字だけに絞る（サブセット化。開発の決まり 14、Q-01、Q-05）。
// astro build のあとに実行し、dist/_astro/ のフォントを置き換える。ライセンス（OFL）は dist/fonts/ に置く。
// - 数式（STIX Two Math）：数式の中の文字。MATH テーブルは harfbuzz のサブセット化で、使う文字に関わる部分が残る
// - 本文・見出し（CMU Serif / CMU Sans Serif）：ページの文字のうち欧文と記号、グラフのラベルなど画面が動的に出す文字のため ASCII の印字可能な文字すべて
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import subsetFont from "subset-font";

const DIST = "dist";
const ASSETS = join(DIST, "_astro");
const html = readFileSync(join(DIST, "index.html"), "utf8");

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

// 数式の文字
const mathChars = new Set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+-−=<>()[]{}|‖,.;:/·∑∫√≤≥≠±×");
for (const m of html.matchAll(/<math\b[\s\S]*?<\/math>/g)) {
  for (const ch of decode(m[0].replace(/<annotation\b[\s\S]*?<\/annotation>/g, "").replace(/<[^>]+>/g, ""))) if (ch.trim()) mathChars.add(ch);
}

// 本文・見出しの欧文の文字（和文は OS のフォントで表示するので含めない）
const textChars = new Set();
for (let c = 0x20; c < 0x7f; c++) textChars.add(String.fromCharCode(c));
for (const ch of "ΔΕεντ₀–—‘’“”×−±≤≥…·°") textChars.add(ch);
const bodyText = decode(html.replace(/<math\b[\s\S]*?<\/math>/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " "));
for (const ch of bodyText) if (ch.codePointAt(0) < 0x3000 && ch.trim()) textChars.add(ch);

const JOBS = [
  { prefix: "stix-two-math", source: "node_modules/@fontsource/stix-two-math/files/stix-two-math-latin-400-normal.woff2", chars: mathChars, license: ["node_modules/@fontsource/stix-two-math/LICENSE", "STIX-Two-Math-OFL.txt"] },
  { prefix: "cmu-serif-500-roman", source: "node_modules/computer-modern/fonts/cmu-serif-500-roman.woff2", chars: textChars },
  { prefix: "cmu-serif-500-italic", source: "node_modules/computer-modern/fonts/cmu-serif-500-italic.woff2", chars: textChars },
  { prefix: "cmu-serif-700-roman", source: "node_modules/computer-modern/fonts/cmu-serif-700-roman.woff2", chars: textChars },
  { prefix: "cmu-sans-serif-700-roman", source: "node_modules/computer-modern/fonts/cmu-sans-serif-700-roman.woff2", chars: textChars, license: ["node_modules/computer-modern/OFL.txt", "CMU-OFL.txt"] },
];

mkdirSync(join(DIST, "fonts"), { recursive: true });
const assets = readdirSync(ASSETS);
for (const job of JOBS) {
  const target = assets.find((f) => f.startsWith(job.prefix) && f.endsWith(".woff2"));
  if (!target) throw new Error(`dist/_astro/ に ${job.prefix} のフォントがありません`);
  const source = readFileSync(job.source);
  const subset = await subsetFont(source, [...job.chars].join(""), { targetFormat: "woff2" });
  writeFileSync(join(ASSETS, target), subset);
  if (job.license) copyFileSync(job.license[0], join(DIST, "fonts", job.license[1]));
  console.log(`subset-fonts: ${job.prefix} ${job.chars.size} 文字、${(source.length / 1024).toFixed(0)} KB → ${(subset.length / 1024).toFixed(1)} KB`);
}
