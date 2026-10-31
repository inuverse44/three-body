// 図 1（4 面図のシミュレーター）と図 2（全エネルギーの相対誤差）。計算はすべて WebAssembly（crates/sim）で行う（C-03）。
// 天体の数（2〜8）と、各天体の質量・位置・速度（3 次元）を利用者が入力できる。有名シナリオは入力欄に値を入れるプリセット（S-05）。
// 図 1 は、静止座標系（原点は重心）と、主星と伴星を結ぶ線が止まって見える回転座標系を切り替えて描ける。

import { rotatingFrame, toFrame, type Frame, type V3 } from "../lib/rotating-frame";
import { recordTimes, TIME_LIMIT, trimTrail } from "../lib/trail";

interface SimExports {
  memory: WebAssembly.Memory;
  sim_max_bodies(): number;
  sim_limit(kind: number): number;
  sim_input(): number;
  sim_load_preset(scenario: number): number;
  sim_preset_dt(scenario: number): number;
  sim_init(slot: number, n: number, method: number, dt: number, tolerance: number): number;
  sim_advance(slot: number, t: number): void;
  sim_time(slot: number): number;
  sim_energy(slot: number): number;
  sim_angular_momentum(slot: number, component: number): number;
  sim_steps(slot: number): number;
  sim_dt(slot: number): number;
  sim_com(slot: number, component: number): number;
  sim_positions(slot: number): number;
  sim_velocities(slot: number): number;
  sim_lagrange(mu: number, k: number, component: number): number;
  sim_times(): number;
  sim_advance_recording(slot: number, until: number, n: number): number;
  sim_sample_positions(slot: number, j: number): number;
  sim_sample_velocities(slot: number, j: number): number;
  sim_sample_com(slot: number, j: number, component: number): number;
}

/** 軌跡の点：重心を引いた位置、その時刻、回転座標系での位置 */
type TrailPoint = [number, number, number, number, number, number, number];
/** 軌跡の点のうち、回転座標系での位置が始まる番号 */
const ROTATING = 4;
const FIELDS = ["m", "x", "y", "z", "vx", "vy", "vz"] as const;
const FIELD_LABELS: Record<(typeof FIELDS)[number], string> = { m: "質量", x: "位置 x", y: "位置 y", z: "位置 z", vx: "速度 vx", vy: "速度 vy", vz: "速度 vz" };
/** 天体 1 つあたりの軌跡の点の上限（描画の速さのため）。超えたら古い部分を間引く（`trimTrail`） */
const TRAIL_MAX_POINTS = 20000;
/** 古い軌跡を薄くするときの段階の数 */
const FADE_BANDS = 8;
const MAIN = 0;
const CHAOS = 1;
const COMPARE = [2, 3, 4];
const METHOD_NAMES = ["RK4", "RK45 (Dormand–Prince)", "Leapfrog"];
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** 10 の累乗を「10⁻¹²」の形で書く（10 の累乗でなければ指数の表記） */
const pow10 = (v: number) => {
  const e = Math.round(Math.log10(v));
  return 10 ** e === v ? `10${String(e).replace("-", "⁻").replace(/\d/g, (d) => SUPERSCRIPT[Number(d)])}` : v.toExponential();
};
/** sim_init の戻り値ごとの理由。範囲の値は計算部分（sim_limit、N-07）から読む */
const initError = (code: number): string =>
  ({
    0: "天体の数・積分法・刻み幅・許容誤差を確かめてください（刻み幅と許容誤差は正の数）。",
    2: `質量は ${pow10(wasm.sim_limit(0))} 以上 ${pow10(wasm.sim_limit(1))} 以下の数にしてください。`,
    3: "数値として読めない値があります。",
    4: `2 つの天体の間隔が ${pow10(wasm.sim_limit(3))} より小さい（重なっている）です。間隔を ${pow10(wasm.sim_limit(3))} 以上にしてください。`,
    5: `位置と速度の各成分は −${pow10(wasm.sim_limit(2))} 以上 ${pow10(wasm.sim_limit(2))} 以下にしてください。`,
  })[code] ?? "初期値を確かめてください。";
/** 表示の半幅の範囲（N-08）。描画の倍率（画面の幅 ÷ 2 ÷ 半幅）と、半幅 × 0.8 の軸の長さが有限で正になるように収める */
const MIN_HALF = 1e-300;
const MAX_HALF = Number.MAX_VALUE / 4;
const DEFAULT_VIEW = { az: -0.6, el: 0.45 };
const FRAME_ERROR = "いまは回転座標系を決められません（主星と伴星が重なっているか、値が大きすぎます）。静止座標系に切り替えると表示できます。";

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const root = $<HTMLElement>("[data-simulator]");
const orbits = $<HTMLCanvasElement>("#orbits");
const energyCanvas = $<HTMLCanvasElement>("#energy");
const presetSelect = $<HTMLSelectElement>("#preset");
const methodSelect = $<HTMLSelectElement>("#method");
const dtInput = $<HTMLInputElement>("#dt");
const tolInput = $<HTMLInputElement>("#tolerance");
const speedSelect = $<HTMLSelectElement>("#speed");
const trailSelect = $<HTMLSelectElement>("#trail");
const chaosToggle = $<HTMLInputElement>("#chaos");
const chaosBody = $<HTMLSelectElement>("#chaos-body");
const chaosDelta = (axis: "x" | "y" | "z") => $<HTMLInputElement>(`#chaos-d${axis}`);
const rotatingToggle = $<HTMLInputElement>("#rotating");
const primarySelect = $<HTMLSelectElement>("#primary");
const secondarySelect = $<HTMLSelectElement>("#secondary");
const playButton = $<HTMLButtonElement>("#play");
const applyButton = $<HTMLButtonElement>("#apply");
const addBodyButton = $<HTMLButtonElement>("#add-body");
const removeBodyButton = $<HTMLButtonElement>("#remove-body");
const compareButton = $<HTMLButtonElement>("#compare");
const compareUntil = $<HTMLInputElement>("#compare-until");
const tableBody = $<HTMLTableSectionElement>("[data-initial] tbody");
const message = $<HTMLElement>("[data-message]");
const out = (id: string) => $<HTMLElement>(`[data-out="${id}"]`);

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colorOf = (i: number) => css(`--series-${(i % 8) + 1}`);
const fmt = (v: number, digits = 3) => (Number.isFinite(v) ? v.toExponential(digits - 1) : "—");

let wasm: SimExports;
let maxBodies = 8;
let bodies = 3;
let playing = false;
/** 予約した描画のコールバック（0 は予約なし）。アニメーションの連鎖を 1 本に保つため、予約は常に高々 1 つ */
let frameRequest = 0;
let simTime = 0;
let lastFrame = 0;
let lastSample = -Infinity;
let slots: number[] = [MAIN];
/** 軌跡：計算（スロット）→ 天体 → 点の列 */
let trails: TrailPoint[][][] = [];
let e0: number[] = [];
let l0: V3[] = [];
let masses: number[] = [];
/** 回転座標系の主星と伴星（天体の番号、0 から） */
let pair: [number, number] = [0, 1];
let view = { ...DEFAULT_VIEW, half: 1.5, zoom: 1 };
type EnergySeries = { label: string; color: number; dashed: boolean; points: [number, number][] };
/** いまの運動の誤差の系列（スロットの順）。frame() はこれにだけ点を足す */
let runSeries: EnergySeries[] = [];
/** 図 2 に描く系列：いまの運動の系列か、3 つの積分法の比較の系列 */
let energySeries: EnergySeries[] = [];

// ---- 初期値の表 ----
function renderRows(n: number): void {
  const old = readTable();
  tableBody.replaceChildren(
    ...Array.from({ length: n }, (_, b) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      const sw = document.createElement("span");
      sw.className = `swatch s${b + 1}`;
      th.append(sw, `天体 ${b + 1}`);
      tr.append(th);
      for (const f of FIELDS) {
        const td = document.createElement("td");
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.inputMode = "decimal";
        input.name = `b${b}-${f}`;
        input.setAttribute("aria-label", `天体 ${b + 1} の ${FIELD_LABELS[f]}`);
        input.value = old[b]?.[FIELDS.indexOf(f)] ?? (f === "m" ? "1" : f === "x" ? String(b) : "0");
        input.addEventListener("input", () => (presetSelect.value = "-1"));
        td.append(input);
        tr.append(td);
      }
      return tr;
    }),
  );
  bodies = n;
  addBodyButton.disabled = n >= maxBodies;
  removeBodyButton.disabled = n <= 2;
  const bodyOptions = () =>
    Array.from({ length: n }, (_, b) => {
      const o = document.createElement("option");
      o.value = String(b);
      o.textContent = `天体 ${b + 1}`;
      return o;
    });
  chaosBody.replaceChildren(...bodyOptions());
  // 主星と伴星は、選んでいた天体が残っていればそのまま、なければ天体 1・2 にする
  if (!pair.every((b) => b < n)) pair = [0, 1];
  primarySelect.replaceChildren(...bodyOptions());
  secondarySelect.replaceChildren(...bodyOptions());
  primarySelect.value = String(pair[0]);
  secondarySelect.value = String(pair[1]);
}

function readTable(): string[][] {
  return Array.from(tableBody.querySelectorAll("tr"), (tr) => Array.from(tr.querySelectorAll("input"), (i) => i.value));
}

function readInputs(): number[] | null {
  const values = readTable().flat().map(Number);
  return values.length === bodies * FIELDS.length && values.every(Number.isFinite) ? values : null;
}

function inputBuffer(): Float64Array {
  return new Float64Array(wasm.memory.buffer, wasm.sim_input(), maxBodies * FIELDS.length);
}

function loadPreset(): void {
  const id = Number(presetSelect.value);
  if (id < 0) return;
  const n = wasm.sim_load_preset(id);
  const buffer = inputBuffer();
  tableBody.replaceChildren();
  renderRows(n);
  readTable().forEach((row, b) =>
    row.forEach((_, k) => {
      const input = tableBody.querySelector<HTMLInputElement>(`input[name="b${b}-${FIELDS[k]}"]`)!;
      input.value = String(Number(buffer[b * FIELDS.length + k].toPrecision(10)));
    }),
  );
  dtInput.value = String(wasm.sim_preset_dt(id));
  // L4 の周りの揺れを見せるプリセットは、天体 1・2 を主星・伴星とする回転座標系で始める
  const option = presetSelect.selectedOptions[0];
  rotatingToggle.checked = option.hasAttribute("data-rotating");
  if (rotatingToggle.checked) {
    pair = [0, 1];
    primarySelect.value = "0";
    secondarySelect.value = "1";
  }
  // 揺れがゆっくりなプリセットは、速く再生し、軌跡をすべて残して形を見せる
  if (option.dataset.speed) speedSelect.value = option.dataset.speed;
  if (option.dataset.trail) trailSelect.value = option.dataset.trail;
  syncRotatingFields();
}

// ---- 計算 ----
function vectors(address: number): V3[] {
  const raw = new Float64Array(wasm.memory.buffer, address, bodies * 3);
  return Array.from({ length: bodies }, (_, i): V3 => [raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]]);
}
/** いまの状態（j を省くとき）か、直前の sim_advance_recording で記録した j 番目の状態の位置・速度・重心 */
const positions = (slot: number, j?: number) => vectors(j === undefined ? wasm.sim_positions(slot) : wasm.sim_sample_positions(slot, j));
const velocities = (slot: number, j?: number) => vectors(j === undefined ? wasm.sim_velocities(slot) : wasm.sim_sample_velocities(slot, j));
const com = (slot: number, j?: number): V3 => [0, 1, 2].map((k) => (j === undefined ? wasm.sim_com(slot, k) : wasm.sim_sample_com(slot, j, k))) as V3;
const angular = (slot: number): V3 => [0, 1, 2].map((k) => wasm.sim_angular_momentum(slot, k)) as V3;

function settings() {
  return { method: Number(methodSelect.value), dt: Number(dtInput.value), tolerance: Number(tolInput.value) };
}

function initSlot(slot: number, values: number[], method: number, dt: number, tolerance: number): boolean {
  inputBuffer().set(values);
  const code = wasm.sim_init(slot, bodies, method, dt, tolerance);
  if (code !== 1) {
    message.textContent = initError(code);
    return false;
  }
  return true;
}

function perturbed(values: number[]): number[] {
  const copy = [...values];
  const b = Number(chaosBody.value);
  (["x", "y", "z"] as const).forEach((axis, k) => (copy[b * FIELDS.length + 1 + k] += Number(chaosDelta(axis).value)));
  return copy;
}

/** いまの（j を渡すときは記録した j 番目の状態の）回転座標系（本計算の主星と伴星から決める。カオスの破線の計算も同じ座標系で描く） */
function currentFrame(j?: number): Frame | null {
  const p = positions(MAIN, j);
  const v = velocities(MAIN, j);
  const body = (b: number) => ({ m: masses[b], p: p[b], v: v[b] });
  return rotatingFrame(body(pair[0]), body(pair[1]));
}

/** 各天体の、重心を引いた位置と、回転座標系での位置。座標系が決まらないとき（2 天体が重なる、値があふれる）は、
 * 回転座標系での位置を NaN にする（ほかの座標系の位置で代えると、回転座標系の軌跡に混ざる）。NaN の点は描かない */
function sample(slot: number, frame: Frame | null, j?: number): [V3, V3][] {
  const c = com(MAIN, j);
  return positions(slot, j).map((p): [V3, V3] => {
    const relative: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [relative, frame ? toFrame(frame, p) : [NaN, NaN, NaN]];
  });
}

const isFinitePoint = (p: V3) => p.every(Number.isFinite);

const trailPoint = ([relative, rotated]: [V3, V3], t: number): TrailPoint => [...relative, t, ...rotated];

/** いま表示している座標系での、軌跡の点の位置 */
const shown = (point: TrailPoint): V3 => {
  const k = rotatingToggle.checked ? ROTATING : 0;
  return [point[k], point[k + 1], point[k + 2]];
};

/** 軌跡を、いまの位置の 1 点から描き直す */
function restartTrails(): void {
  const frame = currentFrame();
  trails = slots.map((s) => sample(s, frame).map((b): TrailPoint[] => [trailPoint(b, simTime)]));
}

function apply(): void {
  setPlaying(false);
  message.textContent = "";
  const values = readInputs();
  if (!values) {
    message.textContent = initError(3);
    return;
  }
  const { method, dt, tolerance } = settings();
  slots = chaosToggle.checked ? [MAIN, CHAOS] : [MAIN];
  if (!initSlot(MAIN, values, method, dt, tolerance)) return;
  if (chaosToggle.checked && !initSlot(CHAOS, perturbed(values), method, dt, tolerance)) return;
  masses = Array.from({ length: bodies }, (_, b) => values[b * FIELDS.length]);
  for (const s of slots) {
    e0[s] = wasm.sim_energy(s);
    l0[s] = angular(s);
  }
  simTime = 0;
  lastSample = -Infinity;
  restartTrails();
  view.half = 0;
  fitView();
  runSeries = slots.map((_, k) => ({
    label: k === 0 ? METHOD_NAMES[method] : `${METHOD_NAMES[method]}（ずらした初期値）`,
    color: method,
    dashed: k === 1,
    points: [],
  }));
  energySeries = runSeries;
  $<HTMLElement>("[data-chaos-legend]").hidden = !chaosToggle.checked;
  drawOrbits();
  drawEnergy();
  updateReadout();
  playButton.disabled = false;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setPlaying(true);
}

/** 表示の範囲を、天体のいまの位置が入るように広げる（all のときは、軌跡のすべての点が入るように決め直す）。
 * 回転座標系では、ラグランジュ点 L1〜L5 の印も入るようにする */
function fitView(all = false): void {
  let need = all ? 0 : view.half;
  const points = trails.flatMap((trail) => trail.flatMap((body) => (all ? body : body.slice(-1)).map(shown)));
  for (const p of [...points, ...lagrangeMarks()]) {
    if (!isFinitePoint(p)) continue;
    need = Math.max(need, ...p.map((v) => Math.abs(v) * 1.15));
  }
  view.half = Math.min(Math.max(need, 0.5), MAX_HALF);
  orbits.dataset.viewHalf = String(view.half); // e2e テストで表示の範囲を確かめるため
}

// ---- 4 面図 ----
interface Panel {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  project: (p: V3) => [number, number];
  axes: [string, V3][];
  /** ラグランジュ点の印を描くか（印は z′ = 0 の面にあるので、横から見る 2 面では軸と重なる） */
  lagrange: boolean;
}

function rotate([x, y, z]: V3): [number, number] {
  const { az, el } = view;
  const x1 = x * Math.cos(az) - y * Math.sin(az);
  const y1 = x * Math.sin(az) + y * Math.cos(az);
  return [x1, y1 * Math.sin(el) + z * Math.cos(el)];
}

function panels(): Panel[] {
  const w = orbits.width / 2;
  const h = orbits.height / 2;
  // 回転座標系の軸には ′ をつける
  const [x, y, z] = ["x", "y", "z"].map((a) => (rotatingToggle.checked ? `${a}′` : a));
  return [
    { x: 0, y: 0, w, h, title: "3D（ドラッグで回転）", project: rotate, axes: [[x, [1, 0, 0]], [y, [0, 1, 0]], [z, [0, 0, 1]]], lagrange: true },
    { x: w, y: 0, w, h, title: x + y, project: ([u, v]) => [u, v], axes: [[x, [1, 0, 0]], [y, [0, 1, 0]]], lagrange: true },
    { x: 0, y: h, w, h, title: x + z, project: ([u, , v]) => [u, v], axes: [[x, [1, 0, 0]], [z, [0, 0, 1]]], lagrange: false },
    { x: w, y: h, w, h, title: y + z, project: ([, u, v]) => [u, v], axes: [[y, [0, 1, 0]], [z, [0, 0, 1]]], lagrange: false },
  ];
}

function drawOrbits(): void {
  const g = orbits.getContext("2d")!;
  g.fillStyle = css("--paper");
  g.fillRect(0, 0, orbits.width, orbits.height);
  const half = Math.min(Math.max(view.half / view.zoom, MIN_HALF), MAX_HALF);
  const current = trails.map((trail) => trail.map((body) => shown(body[body.length - 1])));
  const marks = lagrangeMarks();
  // 回転座標系がいま決まらないときは、理由を表示する（決まったら消す）
  const undetermined = rotatingToggle.checked && current.length > 0 && !current[0].every(isFinitePoint);
  if (undetermined) message.textContent = FRAME_ERROR;
  else if (message.textContent === FRAME_ERROR) message.textContent = "";
  for (const panel of panels()) {
    const scale = Math.min(panel.w, panel.h) / 2 / half;
    orbits.dataset.scale = String(scale); // e2e テストで描画の倍率を確かめるため（4 面とも同じ大きさ）
    const cx = panel.x + panel.w / 2;
    const cy = panel.y + panel.h / 2;
    const toScreen = (p: V3): [number, number] => {
      const [u, v] = panel.project(p);
      return [cx + u * scale, cy - v * scale];
    };
    g.save();
    g.beginPath();
    g.rect(panel.x, panel.y, panel.w, panel.h);
    g.clip();
    // 座標軸（原点 = 重心）
    g.lineWidth = 1;
    for (const [name, dir] of panel.axes) {
      const [ex, ey] = toScreen(dir.map((d) => d * half * 0.8) as V3);
      g.strokeStyle = css("--rule");
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(ex, ey);
      g.stroke();
      g.fillStyle = css("--muted");
      g.font = `18px ${css("--font-body")}`;
      g.fillText(name, ex + 4, ey - 4);
    }
    // ラグランジュ点（回転座標系のときだけ）
    g.strokeStyle = css("--muted");
    g.fillStyle = css("--muted");
    g.font = `16px ${css("--font-body")}`;
    (panel.lagrange ? marks : []).forEach((p, k) => {
      const [sx, sy] = toScreen(p);
      g.beginPath();
      g.moveTo(sx - 5, sy);
      g.lineTo(sx + 5, sy);
      g.moveTo(sx, sy - 5);
      g.lineTo(sx, sy + 5);
      g.stroke();
      g.fillText(`L${k + 1}`, sx + 6, sy + 16);
    });
    // 1. 軌跡（全天体の線を先に描き、点がその上に来るようにする）。古い部分ほど薄く描く（「すべて残す」のときは薄くしない）
    const trailLength = Number(trailSelect.value);
    const fade = Number.isFinite(trailLength) && trailLength > 0;
    slots.forEach((_, s) => {
      g.setLineDash(s === 1 ? [6, 5] : []);
      g.lineWidth = s === 1 ? 1.2 : 1.6;
      for (let i = 0; i < bodies; i++) {
        const points = trails[s][i];
        if (points.length < 2) continue;
        g.strokeStyle = colorOf(i);
        const bands = fade ? FADE_BANDS : 1;
        const per = Math.ceil((points.length - 1) / bands);
        for (let band = 0; band < bands; band++) {
          const from = band * per;
          const to = Math.min(points.length - 1, from + per);
          if (to <= from) continue;
          g.globalAlpha = fade ? 0.15 + (0.85 * (band + 1)) / bands : 1;
          g.beginPath();
          // 描けない点（NaN）では線を切る
          let penDown = false;
          for (let k = from; k <= to; k++) {
            const p = shown(points[k]);
            if (!isFinitePoint(p)) {
              penDown = false;
              continue;
            }
            const [sx, sy] = toScreen(p);
            if (penDown) g.lineTo(sx, sy);
            else g.moveTo(sx, sy);
            penDown = true;
          }
          g.stroke();
        }
      }
    });
    g.globalAlpha = 1;
    g.setLineDash([]);
    // 2. 天体の現在の位置（すべての線の上に描く）
    slots.forEach((_, s) => {
      for (let i = 0; i < bodies; i++) {
        if (!isFinitePoint(current[s][i])) continue;
        const [sx, sy] = toScreen(current[s][i]);
        g.fillStyle = colorOf(i);
        g.strokeStyle = css("--paper");
        g.lineWidth = 2;
        g.globalAlpha = s === 1 ? 0.6 : 1;
        g.beginPath();
        g.arc(sx, sy, 3 + 4 * Math.cbrt(masses[i] / Math.max(...masses)), 0, 2 * Math.PI);
        g.fill();
        g.stroke();
      }
    });
    g.globalAlpha = 1;
    // 3. 番号（色だけに頼らない）
    g.fillStyle = css("--text");
    g.font = `16px ${css("--font-body")}`;
    for (let i = 0; i < bodies; i++) {
      if (!isFinitePoint(current[0][i])) continue;
      const [sx, sy] = toScreen(current[0][i]);
      g.fillText(String(i + 1), sx + 8, sy - 6);
    }
    g.restore();
    g.fillStyle = css("--text");
    g.font = `20px ${css("--font-body")}`;
    g.fillText(panel.title, panel.x + 10, panel.y + 24);
  }
  g.strokeStyle = css("--rule");
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(orbits.width / 2, 0);
  g.lineTo(orbits.width / 2, orbits.height);
  g.moveTo(0, orbits.height / 2);
  g.lineTo(orbits.width, orbits.height / 2);
  g.stroke();
  g.fillStyle = css("--muted");
  g.font = `16px ${css("--font-body")}`;
  const origin = rotatingToggle.checked
    ? `rotating frame: origin = center of mass of bodies ${pair[0] + 1} and ${pair[1] + 1}, x′ toward body ${pair[1] + 1}`
    : "origin = center of mass";
  g.fillText(`axis length = ${(half * 0.8).toPrecision(2)} (G = 1 units), ${origin}`, 10, orbits.height - 10);
}

/** 回転座標系での L1〜L5 の位置（主星と伴星のいまの間隔で拡大する）。静止座標系のときは描かない */
function lagrangeMarks(): V3[] {
  if (!rotatingToggle.checked) return [];
  const frame = currentFrame();
  if (!frame) return [];
  // sim_lagrange は 2 天体の重心を原点とし、間隔を 1 とした位置を返す
  return [0, 1, 2, 3, 4].map((k) => [0, 1, 2].map((c) => wasm.sim_lagrange(frame.mu, k, c) * frame.separation) as V3);
}

function relativeEnergyError(slot: number): number {
  return Math.abs((wasm.sim_energy(slot) - e0[slot]) / e0[slot]);
}

function updateReadout(): void {
  out("time").textContent = wasm.sim_time(MAIN).toFixed(2);
  out("steps").textContent = wasm.sim_steps(MAIN).toLocaleString("ja-JP");
  out("dt").textContent = fmt(wasm.sim_dt(MAIN));
  out("energy").textContent = fmt(relativeEnergyError(MAIN));
  const l = angular(MAIN);
  out("angular").textContent = fmt(Math.hypot(l[0] - l0[MAIN][0], l[1] - l0[MAIN][1], l[2] - l0[MAIN][2]));
  if (slots.length === 2) {
    const a = positions(MAIN);
    const b = positions(CHAOS);
    out("separation").textContent = fmt(Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1], p[2] - b[i][2]))));
  } else {
    out("separation").textContent = "—";
  }
}

function frame(now: number): void {
  frameRequest = 0;
  if (!playing) return;
  // 描画の時刻は、再生を始めた時刻（performance.now()）より前のことがあるので、0 未満にしない（時刻を戻さない）
  const elapsed = Math.max(0, Math.min((now - lastFrame) / 1000, 0.1));
  lastFrame = now;
  const from = simTime;
  // 記録できる時刻の上限（TIME_LIMIT）で止める
  simTime = Math.min(simTime + elapsed * Number(speedSelect.value), TIME_LIMIT);
  // 軌跡の点は、描画の頻度と再生の速さによらず TRAIL_DT ごとに記録する（速く再生しても周期の短い軌道が角ばらない）。
  // 計算は描画の終わりの時刻まで 1 回で進め、途中の時刻の状態は刻みの間の補間で求める（記録する時刻で刻みを切らない。issue #32）
  const times = recordTimes(from, simTime);
  if (times.length > 0) {
    // アドレスを先に求めてから memory.buffer を読む（初めての sim_times は配列を確保してメモリを広げ、それより前に読んだ
    // memory.buffer は使えなくなるため）
    const address = wasm.sim_times();
    new Float64Array(wasm.memory.buffer, address, times.length).set(times);
    slots.forEach((slot) => wasm.sim_advance_recording(slot, simTime, times.length));
    times.forEach((t, j) => {
      const rotation = currentFrame(j);
      slots.forEach((slot, s) => sample(slot, rotation, j).forEach((b, i) => trails[s][i].push(trailPoint(b, t))));
    });
  }
  // 選んだ長さ（時間）より古い点を捨てる。「すべて残す」でも点の数には上限を設ける
  const trailLength = Number(trailSelect.value);
  for (const trail of trails) for (const points of trail) trimTrail(points, trailLength, TRAIL_MAX_POINTS);
  // テストで確かめるため、天体 1 の軌跡の点の数を出す
  root.dataset.trailPoints = String(trails[0][0].length);
  if (simTime - lastSample > 0.02) {
    lastSample = simTime;
    slots.forEach((slot, s) => runSeries[s].points.push([simTime, relativeEnergyError(slot)]));
    drawEnergy();
  }
  fitView();
  drawOrbits();
  updateReadout();
  if (simTime >= TIME_LIMIT) {
    setPlaying(false);
    message.textContent = `時刻が ${TIME_LIMIT.toExponential()} に達したので、再生を止めました（軌跡を記録できる時刻の上限）。`;
    return;
  }
  frameRequest = requestAnimationFrame(frame);
}

function setPlaying(value: boolean): void {
  playing = value;
  playButton.setAttribute("aria-pressed", String(value));
  playButton.textContent = value ? "一時停止" : "再生";
  // 止めるときも、再生し直すときも、前の予約を取り消す（apply() のように止めてすぐ再生すると、古い連鎖が残るため）
  cancelAnimationFrame(frameRequest);
  frameRequest = 0;
  if (value) {
    // 比較の結果を表示していたら、いまの運動の系列（比較の前の点を含む）に戻す
    if (energySeries !== runSeries) {
      energySeries = runSeries;
      drawEnergy();
    }
    lastFrame = performance.now();
    frameRequest = requestAnimationFrame(frame);
  }
}

// ---- 視点の操作（ドラッグ、キーボード、ボタン） ----
function setupViewControls(): void {
  let drag: { x: number; y: number } | null = null;
  orbits.addEventListener("pointerdown", (e) => {
    const rect = orbits.getBoundingClientRect();
    const inside3d = e.clientX - rect.left < rect.width / 2 && e.clientY - rect.top < rect.height / 2;
    if (!inside3d) return;
    drag = { x: e.clientX, y: e.clientY };
    orbits.setPointerCapture(e.pointerId);
  });
  orbits.addEventListener("pointermove", (e) => {
    if (!drag) return;
    view.az += (e.clientX - drag.x) * 0.01;
    view.el = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, view.el + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
    drawOrbits();
  });
  orbits.addEventListener("pointerup", () => (drag = null));
  orbits.addEventListener("keydown", (e) => {
    const step = 0.1;
    if (e.key === "ArrowLeft") view.az -= step;
    else if (e.key === "ArrowRight") view.az += step;
    else if (e.key === "ArrowUp") view.el = Math.min(Math.PI / 2, view.el + step);
    else if (e.key === "ArrowDown") view.el = Math.max(-Math.PI / 2, view.el - step);
    else return;
    e.preventDefault();
    drawOrbits();
  });
  $<HTMLButtonElement>("#zoom-in").addEventListener("click", () => {
    view.zoom *= 1.25;
    drawOrbits();
  });
  $<HTMLButtonElement>("#zoom-out").addEventListener("click", () => {
    view.zoom /= 1.25;
    drawOrbits();
  });
  $<HTMLButtonElement>("#view-reset").addEventListener("click", () => {
    Object.assign(view, DEFAULT_VIEW, { zoom: 1 });
    drawOrbits();
  });
}

// ---- 図 2 ----
function niceStep(range: number): number {
  const raw = range / 6;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
}

function drawEnergy(): void {
  const g = energyCanvas.getContext("2d")!;
  const { width, height } = energyCanvas;
  const pad = { left: 96, right: 16, top: 16, bottom: 64 };
  g.fillStyle = css("--paper");
  g.fillRect(0, 0, width, height);
  const all = energySeries.flatMap((s) => s.points);
  const tMax = Math.max(1, ...all.map(([t]) => t));
  const positive = all.map(([, e]) => e).filter((e) => e > 0);
  const hi = Math.min(2, Math.ceil(Math.log10(Math.max(1e-16, ...positive))) + 1);
  const lo = Math.min(hi - 4, Math.floor(Math.log10(Math.min(1, ...positive))) - 1, -12);
  const x = (t: number) => pad.left + (t / tMax) * (width - pad.left - pad.right);
  const y = (v: number) => {
    const e = Math.min(hi, Math.max(lo, Math.log10(Math.max(v, 10 ** lo))));
    return pad.top + ((hi - e) / (hi - lo)) * (height - pad.top - pad.bottom);
  };
  g.strokeStyle = css("--grid");
  g.fillStyle = css("--muted");
  g.font = `20px ${css("--font-body")}`;
  g.lineWidth = 1;
  const yStep = Math.max(1, Math.ceil((hi - lo) / 6));
  for (let e = lo; e <= hi; e += yStep) {
    g.beginPath();
    g.moveTo(pad.left, y(10 ** e));
    g.lineTo(width - pad.right, y(10 ** e));
    g.stroke();
    g.fillText(`1e${e}`, pad.left - 58, y(10 ** e) + 6);
  }
  const tStep = niceStep(tMax);
  for (let t = 0; t <= tMax + 1e-9; t += tStep) {
    g.beginPath();
    g.moveTo(x(t), pad.top);
    g.lineTo(x(t), height - pad.bottom);
    g.stroke();
    g.fillText(String(Number(t.toPrecision(6))), x(t) - 8, height - pad.bottom + 24);
  }
  g.fillStyle = css("--text");
  g.fillText("Time t (G = 1 units)", width / 2 - 90, height - 8);
  g.save();
  g.translate(22, height / 2 + 150);
  g.rotate(-Math.PI / 2);
  g.fillText("Relative energy error |ΔE / E₀|", 0, 0);
  g.restore();
  for (const series of energySeries) {
    g.strokeStyle = colorOf(series.color);
    g.lineWidth = 2.5;
    g.setLineDash(series.dashed ? [6, 5] : []);
    g.beginPath();
    series.points.forEach(([t, v], k) => (k === 0 ? g.moveTo(x(t), y(v)) : g.lineTo(x(t), y(v))));
    g.stroke();
  }
  g.setLineDash([]);
  $<HTMLUListElement>("[data-energy-legend]").replaceChildren(
    ...energySeries.map((s) => {
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = `swatch s${s.color + 1}${s.dashed ? " dashed" : ""}`;
      li.append(sw, s.label);
      li.dataset.points = String(s.points.length);
      return li;
    }),
  );
}

function compare(): void {
  const values = readInputs();
  if (!values) return;
  const { dt, tolerance } = settings();
  const until = Number(compareUntil.value);
  if (!(until > 0)) return;
  for (let m = 0; m < 3; m++) if (!initSlot(COMPARE[m], values, m, m === 1 ? Math.min(dt, 1e-3) : dt, tolerance)) return;
  const base = COMPARE.map((s) => wasm.sim_energy(s));
  setPlaying(false);
  const compared: EnergySeries[] = [0, 1, 2].map((m) => ({ label: METHOD_NAMES[m], color: m, dashed: false, points: [] }));
  energySeries = compared;
  const sample = until / 400;
  let t = 0;
  // 比較の間は、再生と初期値の選び直しを止める（描画の予約を比較の 1 つに保ち、図 2 の系列に別の計算の点を混ぜないため）
  const controls = [compareButton, playButton, applyButton, presetSelect];
  const wasDisabled = controls.map((c) => c.disabled);
  for (const c of controls) c.disabled = true;
  message.textContent = "3 つの積分法で計算しています…";
  const chunk = () => {
    const end = Math.min(t + sample * 10, until);
    while (t < end) {
      t = Math.min(t + sample, until);
      COMPARE.forEach((slot, m) => {
        wasm.sim_advance(slot, t);
        compared[m].points.push([t, Math.abs((wasm.sim_energy(slot) - base[m]) / base[m])]);
      });
    }
    drawEnergy();
    if (t < until) {
      requestAnimationFrame(chunk);
      return;
    }
    controls.forEach((c, i) => (c.disabled = wasDisabled[i]));
    message.textContent = `時刻 ${until} まで、3 つの積分法で計算しました（刻み幅 ${dt}、RK45 の許容誤差 ${tolerance}）。`;
    $<HTMLTableSectionElement>("[data-compare-table]").replaceChildren(
      ...COMPARE.map((slot, m) => {
        const row = document.createElement("tr");
        const series = compared[m].points.map(([, v]) => v);
        for (const text of [METHOD_NAMES[m], fmt(series.at(-1) ?? NaN), fmt(Math.max(...series)), wasm.sim_steps(slot).toLocaleString("ja-JP")]) {
          const td = document.createElement("td");
          td.textContent = text;
          row.append(td);
        }
        return row;
      }),
    );
  };
  requestAnimationFrame(chunk);
}

function syncRotatingFields(): void {
  $<HTMLElement>("[data-rotating-fields]").hidden = !rotatingToggle.checked;
}

/** 表示する座標系を切り替える。軌跡は両方の座標系で記録しているので、消さずに描き直す */
function switchFrame(): void {
  syncRotatingFields();
  fitView(true);
  drawOrbits();
}

/** 主星（which = 0）か伴星（1）を選び直す。同じ天体を選んだら、もう一方と入れ替える。
 * 過去の速度は持たないので、軌跡はいまの位置から描き直す */
function choosePair(which: 0 | 1): void {
  const selects = [primarySelect, secondarySelect];
  const chosen = Number(selects[which].value);
  if (chosen === pair[1 - which]) selects[1 - which].value = String(pair[which]);
  pair = [Number(primarySelect.value), Number(secondarySelect.value)];
  if (!trails.length) return;
  restartTrails();
  fitView(true);
  drawOrbits();
}

function syncMethodFields(): void {
  const rk45 = methodSelect.value === "1";
  $<HTMLElement>("[data-field=dt]").hidden = rk45;
  $<HTMLElement>("[data-field=tolerance]").hidden = !rk45;
}

async function main(): Promise<void> {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(root.dataset.wasmUrl!), {});
  wasm = instance.exports as unknown as SimExports;
  maxBodies = wasm.sim_max_bodies();
  presetSelect.addEventListener("change", () => {
    loadPreset();
    apply();
  });
  addBodyButton.addEventListener("click", () => {
    presetSelect.value = "-1";
    renderRows(bodies + 1);
  });
  removeBodyButton.addEventListener("click", () => {
    presetSelect.value = "-1";
    renderRows(bodies - 1);
  });
  methodSelect.addEventListener("change", syncMethodFields);
  chaosToggle.addEventListener("change", () => ($<HTMLElement>("[data-chaos-fields]").hidden = !chaosToggle.checked));
  rotatingToggle.addEventListener("change", switchFrame);
  primarySelect.addEventListener("change", () => choosePair(0));
  secondarySelect.addEventListener("change", () => choosePair(1));
  applyButton.addEventListener("click", apply);
  playButton.addEventListener("click", () => setPlaying(!playing));
  compareButton.addEventListener("click", compare);
  setupViewControls();
  trailSelect.addEventListener("change", () => drawOrbits());
  syncMethodFields();
  loadPreset();
  root.dataset.ready = "true";
  applyButton.disabled = false;
  compareButton.disabled = false;
  apply();
}

main().catch((error) => {
  $<HTMLElement>("[data-error]").hidden = false;
  console.error(error);
});
