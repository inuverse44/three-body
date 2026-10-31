// V-03：Lighthouse（モバイル設定）で、全ページの各カテゴリが 90 点以上であることを確かめる。
// @lhci/cli は依存に既知の脆弱性を含むため使わず、Lighthouse 本体と Playwright の Chromium を使う（NFR-13）。
// 使い方：npm run build のあと node scripts/lighthouse.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromium } from "playwright";

const PORT = 4322;
const PAGES = ["/three-body/"];

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const THRESHOLD = 90;
const RUNS = 3; // 計測のぶれを抑えるため、3 回の中央値で判定する

const server = spawn("npx", ["astro", "preview", "--port", String(PORT), "--ignore-lock"], { stdio: "ignore" });
let chrome;
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
    } catch {}
    await sleep(500);
  }

  chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox"],
  });

  const failures = [];
  const rows = [];
  for (const path of PAGES) {
    const results = [];
    for (let i = 0; i < RUNS; i++) {
      results.push(
        await lighthouse(`http://localhost:${PORT}${path}`, {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: CATEGORIES,
        }),
      );
    }
    const median = (c) => {
      const values = results.map((r) => Math.round((r.lhr.categories[c].score ?? 0) * 100)).sort((x, y) => x - y);
      return values[Math.floor(values.length / 2)];
    };
    const scores = Object.fromEntries(CATEGORIES.map((c) => [c, median(c)]));
    const result = results[0];
    rows.push({ path, ...scores });
    for (const [c, s] of Object.entries(scores)) {
      if (s < THRESHOLD) {
        const failing = Object.values(result.lhr.audits)
          .filter((a) => a.score !== null && a.score < 0.9 && result.lhr.categories[c].auditRefs.some((r) => r.id === a.id && r.weight > 0))
          .map((a) => a.id);
        failures.push(`${path} ${c} ${s}（${failing.join(", ")}）`);
      }
    }
  }
  console.table(rows);
  if (failures.length > 0) {
    console.error(`${THRESHOLD} 点未満：\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
} finally {
  await chrome?.kill();
  server.kill();
}
