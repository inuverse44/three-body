// 検証（docs/plan.md §6）：V-06、V-07、V-08
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { v: string[] }).v = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { v: string[] }).v.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  await page.goto("./");
  await expect(page.locator("[data-simulator]")).toHaveAttribute("data-ready", "true");
}
const num = async (page: Page, id: string) => Number(await page.locator(`[data-out="${id}"]`).textContent());
async function setInitial(page: Page, rows: number[][]) {
  const fields = ["m", "x", "y", "z", "vx", "vy", "vz"];
  for (const [b, row] of rows.entries()) for (const [k, v] of row.entries()) await page.fill(`input[name="b${b}-${fields[k]}"]`, String(v));
}

test("V-06：WebAssembly が動き、時間が進み、キャンバスに描かれる。CSP 違反がない", async ({ page }) => {
  await ready(page);
  await expect.poll(() => num(page, "time"), { timeout: 5000 }).toBeGreaterThan(0.5);
  const painted = await page.locator("#orbits").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 60) count++;
    return count;
  });
  expect(painted).toBeGreaterThan(20);
  expect(await page.evaluate(() => (window as unknown as { v: string[] }).v)).toEqual([]);
  const csp = await page.locator('meta[http-equiv="content-security-policy"]').getAttribute("content");
  expect(csp).toContain("'wasm-unsafe-eval'");
});

test("S-05：プリセットの値が入力欄に入り、書き換えると「自分で入力」になる", async ({ page }) => {
  await ready(page);
  await expect(page.locator('input[name="b0-x"]')).toHaveValue("-0.97000436");
  await page.selectOption("#preset", "1");
  await expect(page.locator('input[name="b0-m"]')).toHaveValue("3");
  await page.fill('input[name="b0-m"]', "2");
  await expect(page.locator("#preset")).toHaveValue("-1");
});

test("S-08〜S-16：どのプリセットも読み込めて、誤りなく計算が進む", async ({ page }) => {
  await ready(page);
  const values = await page.locator("#preset option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  // 選択肢は分類ごとに並ぶので、番号の順とは限らない
  const ids = values.filter((v) => v !== "-1").map(Number).sort((a, b) => a - b);
  expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => i));
  for (const value of values.filter((v) => Number(v) >= 4)) {
    await page.selectOption("#preset", value);
    await expect(page.locator("[data-message]")).toHaveText("");
    await expect(page.locator("#preset")).toHaveValue(value);
    await expect.poll(() => num(page, "time"), { timeout: 5000 }).toBeGreaterThan(0.2);
  }
  // 許容誤差の既定は、Rust のテストの「画面と同じ条件」（crates/sim/tests/presets.rs の page_default）と同じ 1e-10
  await expect(page.locator("#tolerance")).toHaveValue("1e-10");
  await expect(page.locator("#method")).toHaveValue("1");
  // 刻み幅の既定はプリセットごと（Rust の scenarios::preset_dt）：崩れて接近をくり返す正三角形は 0.001、8 の字は 0.01
  await page.selectOption("#preset", "8");
  await expect(page.locator("#dt")).toHaveValue("0.001");
  await page.selectOption("#preset", "0");
  await expect(page.locator("#dt")).toHaveValue("0.01");
  // Kepler-16：Doyle ほか（2011）の値が入力欄に入る
  await page.selectOption("#preset", "12");
  await expect(page.locator('input[name="b0-m"]')).toHaveValue("0.6897");
  await expect(page.locator('input[name="b1-m"]')).toHaveValue("0.20255");
});

test("S-05：自分で決めた初期値で計算できる（質量・位置・速度）", async ({ page }) => {
  await ready(page);
  await setInitial(page, [
    [1, -1, 0, 0, 0, -0.5, 0],
    [1, 1, 0, 0, 0, 0.5, 0],
    [0.01, 0, 3, 0.5, 0.4, 0, 0.05],
  ]);
  await page.click("#apply");
  await expect(page.locator("[data-message]")).toHaveText("");
  await expect.poll(() => num(page, "time"), { timeout: 5000 }).toBeGreaterThan(0.5);
  expect(await num(page, "energy")).toBeLessThan(1e-6);
});

test("S-05：誤った初期値は理由を表示して受け付けない（質量 0、重なった位置）", async ({ page }) => {
  await ready(page);
  await page.fill('input[name="b1-m"]', "0");
  await page.click("#apply");
  await expect(page.locator("[data-message]")).toContainText("質量は 10⁻¹² 以上");
  await page.fill('input[name="b1-m"]', "1");
  await page.fill('input[name="b1-x"]', await page.locator('input[name="b0-x"]').inputValue());
  await page.fill('input[name="b1-y"]', await page.locator('input[name="b0-y"]').inputValue());
  await page.click("#apply");
  await expect(page.locator("[data-message]")).toContainText("より小さい（重なっている）");
});

test("N-06：刻み幅を選べ、RK4 では刻み幅を細かくすると全エネルギーの誤差が小さくなる", async ({ page }) => {
  await ready(page);
  await page.selectOption("#method", "0");
  await expect(page.locator("#dt")).toBeVisible();
  await expect(page.locator("#tolerance")).toBeHidden();
  const errorAt = async (dt: string) => {
    await page.fill("#dt", dt);
    await page.click("#apply");
    await expect.poll(() => num(page, "time"), { timeout: 8000 }).toBeGreaterThan(2);
    await page.click("#play"); // 一時停止
    return num(page, "energy");
  };
  const coarse = await errorAt("0.05");
  const fine = await errorAt("0.005");
  expect(fine).toBeLessThan(coarse);
});

test("S-03：カオス：ずらす天体と量を選べ、2 つの計算の位置のずれを表示する", async ({ page }) => {
  await ready(page);
  await page.check("#chaos");
  await expect(page.locator("[data-chaos-fields]")).toBeVisible();
  await page.selectOption("#chaos-body", "2");
  await page.fill("#chaos-dx", "0");
  await page.fill("#chaos-dy", "1e-4");
  await page.fill("#chaos-dz", "1e-4");
  await page.click("#apply");
  await expect(page.locator("[data-chaos-legend]")).toBeVisible();
  await expect.poll(() => num(page, "separation"), { timeout: 5000 }).toBeGreaterThan(0);
});

test("図 2：いまの運動の誤差を描き、3 つの積分法の比較では RK45 の誤差が RK4 より小さい（ピタゴラスの三体問題）", async ({ page }) => {
  await ready(page);
  await expect(page.locator("[data-energy-legend] li")).toHaveCount(1);
  await page.selectOption("#preset", "1");
  await page.fill("#compare-until", "40");
  await page.click("#compare");
  await expect(page.locator("[data-compare-table] tr")).toHaveCount(3, { timeout: 60000 });
  const [rk4, rk45] = (await page.locator("[data-compare-table] tr td:nth-child(3)").allTextContents()).map(Number);
  expect(rk45).toBeLessThan(1e-4);
  expect(rk45).toBeLessThan(rk4);
  await expect(page.locator("[data-energy-legend] li")).toHaveCount(3);
});

test("V-08：数式は MathML で表示され、style 属性を持たない", async ({ page }) => {
  await ready(page);
  expect(await page.locator("math").count()).toBeGreaterThan(10);
  expect(await page.locator("math [style], math[style]").count()).toBe(0);
});

test("Q-02：動きを減らす設定のときは、自動で再生しない", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("http://localhost:4321/three-body/");
  await expect(page.locator("[data-simulator]")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(800);
  expect(await page.locator('[data-out="time"]').textContent()).toBe("0.00");
  await context.close();
});

test.describe("V-07：アクセシビリティ（axe）と画面幅", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(scheme, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.emulateMedia({ colorScheme: scheme });
      await ready(page);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      const serious = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    });
  }
});

test("N 体：天体を 2〜8 個に増減でき、増やした天体で計算できる", async ({ page }) => {
  await ready(page);
  await expect(page.locator("[data-initial] tbody tr")).toHaveCount(3);
  await page.click("#remove-body");
  await expect(page.locator("[data-initial] tbody tr")).toHaveCount(2);
  await expect(page.locator("#remove-body")).toBeDisabled();
  for (let i = 0; i < 6; i++) await page.click("#add-body");
  await expect(page.locator("[data-initial] tbody tr")).toHaveCount(8);
  await expect(page.locator("#add-body")).toBeDisabled();
  await expect(page.locator("#chaos-body option")).toHaveCount(8);
  // 8 体：x 軸上に並べて静止させる（既定値）→ 重なりはないので計算できる
  await page.click("#apply");
  await expect(page.locator("[data-message]")).toHaveText("");
  await expect.poll(() => num(page, "time"), { timeout: 5000 }).toBeGreaterThan(0.2);
});

test("3 次元：3 次元のプリセットでは、xz 平面の図にも動きが描かれる", async ({ page }) => {
  await ready(page);
  await page.selectOption("#preset", "3");
  await expect(page.locator('input[name="b2-vz"]')).not.toHaveValue("0");
  await expect.poll(() => num(page, "time"), { timeout: 8000 }).toBeGreaterThan(3);
  // 左下（xz 平面）のパネルに、背景と違う色の画素がある
  const painted = await page.locator("#orbits").evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext("2d")!;
    const d = g.getImageData(0, c.height / 2 + 30, c.width / 2, c.height / 2 - 60).data;
    let count = 0;
    for (let i = 0; i < d.length; i += 4 * 31) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 60) count++;
    return count;
  });
  expect(painted).toBeGreaterThan(20);
});

test("3 次元：立体図をドラッグと矢印キーで回せる", async ({ page }) => {
  await ready(page);
  await page.click("#play"); // 一時停止して、画像の変化が回転だけによるものにする
  const snapshot = () => page.locator("#orbits").evaluate((c: HTMLCanvasElement) => c.toDataURL());
  const before = await snapshot();
  const box = (await page.locator("#orbits").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3, { steps: 5 });
  await page.mouse.up();
  const dragged = await snapshot();
  expect(dragged).not.toBe(before);
  await page.locator("#orbits").focus();
  await page.keyboard.press("ArrowRight");
  expect(await snapshot()).not.toBe(dragged);
  await page.click("#view-reset");
  expect(await snapshot()).toBe(before);
});

test("軌跡の長さ：0 から ∞ まで選べ、短くすると描かれる線が減る", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#trail option")).toHaveCount(8);
  await page.selectOption("#speed", "3");
  await page.selectOption("#trail", "Infinity");
  await page.click("#apply");
  await expect.poll(() => num(page, "time"), { timeout: 8000 }).toBeGreaterThan(5);
  // 天体 3 の色（緑）の系統の画素だけを数える。8 の字の解では 3 天体が同じ道を通り、最後に描く天体 3 の線が一番上に来るため
  // （座標軸や文字は灰色なので数えない。線の縁が背景と混ざっても緑みは残る）
  const colored = () =>
    page.locator("#orbits").evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] - d[i] > 50 && d[i + 1] - d[i + 2] > 15) count++;
      return count;
    });
  await page.click("#play"); // 一時停止
  const all = await colored();
  await page.selectOption("#trail", "0");
  await page.click("#play"); // 再生して、短い軌跡に切り替わるのを待つ
  await page.waitForTimeout(500);
  await page.click("#play");
  const none = await colored();
  expect(none).toBeLessThan(all / 3);
});

test("フォント：本文は Computer Modern Roman（＋明朝体）、節タイトルは Computer Modern Sans（＋ゴシック体）", async ({ page }) => {
  await ready(page);
  const family = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await family("h2")).toMatch(/^"CMU Sans Serif"/);
  expect(await family("h2")).toContain("Gothic");
  expect(await family("main p")).toMatch(/^"CMU Serif"/);
  expect(await family("main p")).toContain("Mincho");
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replaceAll('"', "")));
  expect(loaded).toEqual(expect.arrayContaining(["CMU Serif", "CMU Sans Serif"]));
});

test("回転座標系：L4 のプリセットでは伴星と L4 の天体が止まって見え、静止座標系に切り替えると円を描く", async ({ page }) => {
  await ready(page);
  await page.selectOption("#preset", "9");
  await expect(page.locator("#rotating")).toBeChecked();
  await expect(page.locator("[data-rotating-fields]")).toBeVisible();
  await page.selectOption("#speed", "10");
  await page.selectOption("#trail", "Infinity");
  await page.click("#apply");
  // 静止座標系では、伴星と L4 の天体が 2 周近く回って同じ円を描く
  await expect.poll(() => num(page, "time"), { timeout: 8000 }).toBeGreaterThan(12);
  await page.click("#play"); // 一時停止
  // 色のついた画素（天体と軌跡）を数える。座標軸・文字・ラグランジュ点の印は灰色なので数えない。
  // 伴星と L4 の天体は同じ円を回り、後から描く L4 の天体の線が伴星の線を覆うので、色を分けずに数える
  const colored = () =>
    page.locator("#orbits").evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) count++;
      return count;
    });
  const rotating = await colored();
  await page.uncheck("#rotating");
  await expect(page.locator("[data-rotating-fields]")).toBeHidden();
  const inertial = await colored();
  await page.check("#rotating");
  const again = await colored();
  expect(rotating).toBeGreaterThan(0);
  expect(inertial).toBeGreaterThan(5 * rotating);
  expect(again).toBe(rotating); // 切り替えても軌跡は消えない
  await expect(page.locator("[data-message]")).toHaveText("");
});

test("回転座標系：プリセットごとに座標系・再生の速さ・軌跡の長さが決まり、主星と伴星に同じ天体を選ぶと入れ替わる", async ({ page }) => {
  await ready(page);
  await expect(page.locator("#rotating")).not.toBeChecked();
  for (const id of ["18", "19"]) {
    await page.selectOption("#preset", id);
    await expect(page.locator("#rotating")).toBeChecked();
    await expect(page.locator("#speed")).toHaveValue("10");
    await expect(page.locator("#trail")).toHaveValue("Infinity");
    await expect(page.locator("#primary")).toHaveValue("0");
    await expect(page.locator("#secondary")).toHaveValue("1");
    await expect(page.locator("[data-message]")).toHaveText("");
  }
  await page.selectOption("#primary", "1");
  await expect(page.locator("#secondary")).toHaveValue("0");
  await page.selectOption("#secondary", "2");
  await expect(page.locator("#primary")).toHaveValue("1");
  await page.selectOption("#preset", "0");
  await expect(page.locator("#rotating")).not.toBeChecked();
});

/** キャンバスの色のついた画素（天体と軌跡）の数 */
const colored = (page: Page) =>
  page.locator("#orbits").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let count = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) count++;
    return count;
  });

/** 計算の途中でしか起きない状態（N-07 の範囲の外の位置、2 天体が重なる）を作るため、WebAssembly の sim_positions の出力を、
 * window.fakePositions（天体ごとの x, y, z）があればそれに書き換える。入力の検証（sim_init）は本物のまま通す */
async function fakePositions(page: Page, values: number[]) {
  await page.addInitScript((fake) => {
    const instantiate = WebAssembly.instantiateStreaming;
    WebAssembly.instantiateStreaming = async (source, imports) => {
      const result = await instantiate(source, imports);
      const real = result.instance.exports as Record<string, unknown>;
      const positions = real.sim_positions as (slot: number) => number;
      const exports = {
        ...real,
        sim_positions: (slot: number) => {
          const address = positions(slot);
          new Float64Array((real.memory as WebAssembly.Memory).buffer, address, fake.length).set(fake);
          return address;
        },
      };
      return { module: result.module, instance: { exports } as unknown as WebAssembly.Instance };
    };
  }, values);
}

for (const [name, positions] of [
  ["主星と伴星が重なる", [0, 0, 0, 0, 0, 0, 1, 0, 0]],
  ["主星と伴星の差があふれる（1.15 倍の余白もあふれる）", [-1.7e308, 0, 0, 1.7e308, 0, 0, 1, 0, 0]],
] as [string, number[]][]) {
  test(`回転座標系：計算の途中で座標系が決まらなくなったとき（${name}）は、回転座標系に何も描かず理由を表示し、静止座標の点を混ぜない。静止座標系の表示の倍率は有限で正`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" }); // 自動で再生しない（初期状態だけを描く）
    await fakePositions(page, positions);
    await ready(page);
    await page.check("#rotating");
    await page.click("#apply");
    await expect(page.locator("[data-message]")).toContainText("回転座標系");
    expect(await colored(page)).toBe(0);
    await page.uncheck("#rotating");
    expect(await colored(page)).toBeGreaterThan(0);
    const half = Number(await page.locator("#orbits").getAttribute("data-view-half"));
    const scale = Number(await page.locator("#orbits").getAttribute("data-scale"));
    expect(Number.isFinite(half) && Number.isFinite(scale) && scale > 0, `半幅 ${half}、倍率 ${scale}`).toBe(true);
  });
}

test("回転座標系：表示の範囲に L1〜L5 がすべて入る（回転座標系で始めるときも、あとで切り替えるときも）", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // 自動で再生しない（初期状態の範囲を見る）
  await ready(page);
  await page.click("#remove-body");
  // 質量 1・1、間隔 1 の円軌道（ω² = 2）。μ = 0.5 の L2・L3 は |x′| ≈ 1.1984、L4・L5 は |y′| ≈ 0.866
  const v = Math.sqrt(2) / 2;
  await setInitial(page, [
    [1, -0.5, 0, 0, 0, -v, 0],
    [1, 0.5, 0, 0, 0, v, 0],
  ]);
  const half = async () => Number(await page.locator("#orbits").getAttribute("data-view-half"));
  const farthest = 1.1984;
  await page.check("#rotating");
  await page.click("#apply");
  expect(await half()).toBeGreaterThanOrEqual(farthest);
  await page.uncheck("#rotating");
  await page.click("#apply");
  expect(await half()).toBeLessThan(farthest); // 静止座標系では天体だけから決める
  await page.check("#rotating");
  expect(await half()).toBeGreaterThanOrEqual(farthest);
});

test("V-26：N-07 の範囲の端の初期値（質量 10⁻¹²・10¹²、成分 ±10⁶、間隔 10⁻⁹）は受け付け、回転座標系が決まり、表示の範囲に L 点が入り、倍率は有限で正", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); // 自動で再生しない（初期状態を見る）
  await ready(page);
  await page.click("#remove-body");
  await page.check("#rotating");
  const cases: [string, number[][]][] = [
    ["最大の間隔（3 成分）・最大の速さ", [[1e12, -1e6, 1e6, -1e6, 1e6, 1e6, -1e6], [1e-12, 1e6, -1e6, 1e6, -1e6, -1e6, 1e6]]],
    ["最大の間隔（3 成分）・静止", [[1e-12, -1e6, 1e6, -1e6, 0, 0, 0], [1e12, 1e6, -1e6, 1e6, 0, 0, 0]]],
    ["最小の間隔（軸の向き）", [[1e12, 0, 0, 0, 0, 0, 0], [1e12, 1.000001e-9, 0, 0, 0, 1e6, 0]]],
    ["範囲の角での間隔 √2（斜め）", [[1e-12, 999999, 999999, 0, 0, 0, -1e6], [1e-12, 1e6, 1e6, 0, 0, 0, 1e6]]],
  ];
  for (const [name, rows] of cases) {
    await setInitial(page, rows);
    await page.click("#apply");
    await expect(page.locator("[data-message]"), name).toHaveText("");
    const [a, b] = rows.map((r) => r.slice(1, 4));
    const separation = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const half = Number(await page.locator("#orbits").getAttribute("data-view-half"));
    const scale = Number(await page.locator("#orbits").getAttribute("data-scale"));
    // L3（2 天体の重心から間隔のおよそ 1 倍以上の距離）が表示の範囲に入る
    expect(Number.isFinite(half) && half >= separation, `${name}：半幅 ${half}`).toBe(true);
    expect(Number.isFinite(scale) && scale > 0, `${name}：倍率 ${scale}`).toBe(true);
    expect(await colored(page), name).toBeGreaterThan(0);
  }
});

test("V-26：N-07 の範囲の外は理由を表示して受け付けない。理由とページの文の範囲は、計算部分の値（sim_limit）と一致する", async ({ page }) => {
  await ready(page);
  const reason = page.locator("[data-message]");
  const ranges = await page.locator("[data-range]").allTextContents();
  expect(ranges).toHaveLength(2);
  for (const [field, value] of [["b0-m", "1e308"], ["b1-m", "1e-13"], ["b1-m", "1000000000001"]]) {
    await page.selectOption("#preset", "0");
    await page.fill(`input[name="${field}"]`, value);
    await page.click("#apply");
    await expect(reason, `${field} = ${value}`).toContainText("質量は");
    const [, min, max] = (await reason.textContent())!.match(/質量は (\S+) 以上 (\S+) 以下/)!;
    expect([min, max]).toEqual(["10⁻¹²", "10¹²"]);
    for (const text of ranges) expect(text).toContain(`質量${text.includes("質量は") ? "は" : ""} ${min}〜${max}`);
  }
  for (const [field, value] of [["b0-x", "1000001"], ["b2-vz", "-1e7"], ["b1-y", "1e308"]]) {
    await page.selectOption("#preset", "0");
    await page.fill(`input[name="${field}"]`, value);
    await page.click("#apply");
    await expect(reason, `${field} = ${value}`).toContainText("位置と速度の各成分は");
    const [, c] = (await reason.textContent())!.match(/各成分は −(\S+) 以上/)!;
    expect(c).toBe("10⁶");
    for (const text of ranges) expect(text).toContain(`−${c}〜${c}`);
  }
  // 間隔が下限より小さい異なる位置（5 × 10⁻¹⁰ と、下限のすぐ下）
  for (const x of ["5e-10", "9.99999e-10"]) {
    await page.selectOption("#preset", "0");
    await setInitial(page, [[1, 0, 0, 0, 0, 0, 0], [1, Number(x), 0, 0, 0, 0, 0], [1, 1, 1, 0, 0, 0, 0]]);
    await page.click("#apply");
    await expect(reason, `間隔 ${x}`).toContainText("より小さい（重なっている）");
    const [, s] = (await reason.textContent())!.match(/間隔が (\S+) より小さい/)!;
    expect(s).toBe("10⁻⁹");
    for (const text of ranges) expect(text).toContain(`間隔${text.includes("間隔は") ? "は" : ""} ${s} 以上`);
  }
});

test("V-26：拡大・縮小を何回押しても、描画の倍率は有限で正", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  for (const button of ["#zoom-in", "#zoom-out"]) {
    await page.click("#view-reset");
    await page.locator(button).evaluate((b: HTMLButtonElement) => {
      for (let i = 0; i < 4000; i++) b.click(); // 1.25 の 4000 乗は、倍率を有限の数の外に出す
    });
    const scale = Number(await page.locator("#orbits").getAttribute("data-scale"));
    expect(Number.isFinite(scale) && scale > 0, `${button}：倍率 ${scale}`).toBe(true);
  }
});

type Probe = { pending: () => number; frames: (n: number) => Promise<number[]> };
const probe = (page: Page) => ({
  pending: () => page.evaluate(() => (window as unknown as { probe: Probe }).probe.pending()),
  frames: (n: number) => page.evaluate((n) => (window as unknown as { probe: Probe }).probe.frames(n), n),
});

/** requestAnimationFrame を包み、予約中のコールバックの数と、描画（時刻の引数）ごとに呼ばれた数を数える */
async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    const pending = new Set<number>();
    const calls = new Map<number, number>();
    window.requestAnimationFrame = (callback) => {
      const id = raf((t) => {
        pending.delete(id);
        calls.set(t, (calls.get(t) ?? 0) + 1);
        callback(t);
      });
      pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      caf(id);
    };
    (window as unknown as { probe: Probe }).probe = {
      pending: () => pending.size,
      // 次の n 回の描画で、描画ごとに呼ばれたコールバックの数（数えるための予約は包む前の関数で行い、数に入れない）
      frames: (n) =>
        new Promise((resolve) => {
          calls.clear();
          let k = 0;
          const tick = () => (++k < n ? raf(tick) : resolve([...calls.values()]));
          raf(tick);
        }),
    };
  });
}

test("V-27：再生中に初期値を選び直しても、再生と一時停止を続けて押しても、アニメーションの連鎖は 1 本", async ({ page }) => {
  await countFrames(page);
  await ready(page);
  await expect.poll(() => num(page, "time"), { timeout: 5000 }).toBeGreaterThan(0);
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
  for (const preset of ["1", "2", "0"]) await page.selectOption("#preset", preset);
  for (let i = 0; i < 5; i++) await page.click("#apply");
  for (let i = 0; i < 3; i++) {
    await page.locator("#play").evaluate((b: HTMLButtonElement) => {
      b.click();
      b.click(); // 一時停止と再生を、1 回の描画の間に続けて押す
    });
  }
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
  const counts = await probe(page).frames(25);
  expect(counts.length, "再生中の描画の数").toBeGreaterThanOrEqual(20);
  expect(counts.filter((c) => c !== 1), "コールバックが 1 つでない描画").toEqual([]);
  expect(await probe(page).pending()).toBe(1);

  await page.click("#play");
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "false");
  expect(await probe(page).pending()).toBe(0);
  const time = await page.locator('[data-out="time"]').textContent();
  expect(await probe(page).frames(10)).toEqual([]);
  expect(await page.locator('[data-out="time"]').textContent()).toBe(time);
});

test("V-27：比較の計算の間は、再生・初期値の選び直しができず、予約は比較の 1 つだけ。終わると 0 に戻り、また再生できる", async ({ page }) => {
  await countFrames(page);
  await ready(page);
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
  await page.click("#compare");
  // 比較の途中で、再生と「この初期値で始める」を押す（押せないはず）
  await page.locator("#play").evaluate((b: HTMLButtonElement) => b.click());
  await page.locator("#apply").evaluate((b: HTMLButtonElement) => b.click());
  const counts = await probe(page).frames(10);
  // 数えた描画が比較の途中だったこと
  await expect(page.locator("#compare")).toBeDisabled();
  await expect(page.locator("[data-message]")).toHaveText("3 つの積分法で計算しています…");
  expect(counts.length, "比較の途中の描画の数").toBeGreaterThanOrEqual(8);
  expect(counts.filter((c) => c !== 1), "コールバックが 1 つでない描画").toEqual([]);
  for (const control of ["#play", "#apply", "#preset"]) await expect(page.locator(control), control).toBeDisabled();
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "false");

  await expect(page.locator("[data-message]")).toContainText("3 つの積分法で計算しました", { timeout: 60000 });
  await expect(page.locator("[data-compare-table] tr")).toHaveCount(3);
  expect(await probe(page).pending()).toBe(0);
  await expect(page.locator("[data-energy-legend] li")).toHaveCount(3);
  for (const control of ["#play", "#apply", "#preset", "#compare"]) await expect(page.locator(control), control).toBeEnabled();
  await page.click("#play");
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
  expect((await probe(page).frames(10)).filter((c) => c !== 1)).toEqual([]);
  expect(await probe(page).pending()).toBe(1);
});

test("V-29：速さ 10 でも、軌跡の点は 1/60 単位時間ごとに記録する（Kepler-16 の連星の軌跡が角ばらない）", async ({ page }) => {
  await ready(page);
  await page.selectOption("#preset", "12");
  await page.selectOption("#speed", "10");
  await page.selectOption("#trail", "2");
  await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => num(page, "time"), { timeout: 8000 }).toBeGreaterThan(4);
  await page.click("#play");
  // 長さ 2 の軌跡には、1/60 ごとの点が 120 ある（ほかに各描画の終わりの時刻の点も入る）。
  // 1 回の描画で 1 点だと、60 回 / 秒・速さ 10 で 12 点ほど
  const points = Number(await page.locator("[data-simulator]").getAttribute("data-trail-points"));
  expect(points).toBeGreaterThanOrEqual(120);
});

/** 図 2 の凡例：系列の名前と点の数 */
const energyLegend = (page: Page) =>
  page.locator("[data-energy-legend] li").evaluateAll((items) => items.map((li) => ({ label: li.textContent, points: Number((li as HTMLElement).dataset.points) })));

for (const chaos of [false, true]) {
  test(`V-28：比較のあとに再生すると、図 2 はいまの運動の系列（比較の前の点を含む）に戻り、その系列に点が足されていく（カオス${chaos ? "あり" : "なし"}）`, async ({ page }) => {
    await ready(page);
    if (chaos) {
      await page.check("#chaos");
      await page.click("#apply");
    }
    await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => Math.min(...(await energyLegend(page)).map((s) => s.points)), { timeout: 5000 }).toBeGreaterThan(0);
    await page.click("#play");
    await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "false");
    const before = await energyLegend(page);
    expect(before.length).toBe(chaos ? 2 : 1);

    await page.fill("#compare-until", "5");
    await page.click("#compare");
    await expect(page.locator("[data-message]")).toContainText("3 つの積分法で計算しました", { timeout: 60000 });
    const compared = await energyLegend(page);
    // 比較の結果が図 2 に出ていたこと（再生する前）
    expect(compared.map((s) => s.label)).toEqual(["RK4", "RK45 (Dormand–Prince)", "Leapfrog"]);
    expect(Math.min(...compared.map((s) => s.points))).toBeGreaterThan(0);

    await page.click("#play");
    await expect(page.locator("#play")).toHaveAttribute("aria-pressed", "true");
    // 再生を続け、いまの運動の点が比較の前より増えるのを待つ
    await expect
      .poll(async () => (await energyLegend(page)).every((s, k) => s.points > (before[k]?.points ?? Infinity)), { timeout: 5000 })
      .toBe(true);
    const after = await energyLegend(page);
    expect(after.map((s) => s.label), "再生のあとの系列").toEqual(before.map((s) => s.label));
  });
}
