// Q-05 性能の予算：WebAssembly は 100KB まで、1 ページが読み込む CSS（外部ファイル＋インライン）は 20KB まで、フォントは 1 ファイル 60KB まで。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const problems = [];
const wasm = statSync(join(DIST, "sim.wasm")).size;
if (wasm > 100 * 1024) problems.push(`WebAssembly ${(wasm / 1024).toFixed(1)} KB（上限 100 KB）`);
const html = readFileSync(join(DIST, "index.html"), "utf8");
let css = 0;
for (const m of html.matchAll(/<link rel="stylesheet" href="\/three-body\/([^"]+)"/g)) css += statSync(join(DIST, m[1])).size;
for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) css += Buffer.byteLength(m[1]);
if (css > 20 * 1024) problems.push(`CSS ${(css / 1024).toFixed(1)} KB（上限 20 KB）`);
// フォントは 1 ファイル 60KB まで（サブセット化されていない可能性を見つける。開発の決まり 14）
let mathBytes = 0;
for (const f of readdirSync(join(DIST, "_astro")).filter((f) => f.endsWith(".woff2"))) {
  const bytes = statSync(join(DIST, "_astro", f)).size;
  if (f.startsWith("stix-two-math")) mathBytes = bytes;
  if (bytes > 60 * 1024) problems.push(`フォント ${f} ${(bytes / 1024).toFixed(1)} KB（上限 60 KB。サブセット化されていない可能性）`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`check-asset-budget: 問題はありません（WebAssembly ${(wasm / 1024).toFixed(1)} KB、CSS ${(css / 1024).toFixed(1)} KB、数式のフォント ${(mathBytes / 1024).toFixed(1)} KB）`);
