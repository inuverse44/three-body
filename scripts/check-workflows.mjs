// TC-N10：GitHub Actions のワークフローが DD-13 / DD-16 の決まりを守っているかを検査する（NFR-12）。
// - 外部の Action はコミット SHA（40 桁）で固定する
// - ワークフロー全体の既定の権限は contents: read だけ
// - pull_request_target を使わない
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = ".github/workflows";
const problems = [];

for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  const path = join(dir, name);
  const lines = readFileSync(path, "utf8").split("\n");

  lines.forEach((line, i) => {
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (uses && !uses[1].startsWith("./") && !/@[0-9a-f]{40}$/.test(uses[1])) {
      problems.push(`${path}:${i + 1} コミット SHA で固定されていない Action: ${uses[1]}`);
    }
    if (/^\s*pull_request_target\s*:?/.test(line)) {
      problems.push(`${path}:${i + 1} pull_request_target は使わない`);
    }
  });

  const start = lines.findIndex((l) => /^permissions:\s*$/.test(l));
  if (start === -1) {
    problems.push(`${path}: ワークフロー全体の permissions がない`);
    continue;
  }
  const block = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(l)) break;
    block.push(l.trim());
  }
  if (block.length !== 1 || block[0] !== "contents: read") {
    problems.push(`${path}: ワークフロー全体の permissions は contents: read だけにする（実際: ${block.join(", ") || "なし"}）`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("check-workflows: 問題はありません");
