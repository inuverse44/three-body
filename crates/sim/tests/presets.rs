//! プリセットの検証（docs/plan.md §6：V-14〜V-21、V-23、V-24）。研究済みの周期解、ラグランジュの解、惑星、連星への侵入、
//! シトニコフ問題、ラグランジュ点の位置、L4 からずらしたトロヤ群

use sim::integrators::{Integrator, Method};
use sim::scenarios::{
    BUTTERFLY_I, DRAGONFLY, HORSESHOE_ANGLE_DEG, JUPITER_MU, JUPITER_SUN_MASS_RATIO,
    KEPLER16_INNER_A, KEPLER16_PLANET_A, KOZAI_INCLINATION_DEG, MOTH_I, PRESET_COUNT,
    TADPOLE_ANGLE_DEG, YIN_YANG_I, binary_exchange, binary_ionization, by_id, euler_collinear,
    kepler16, kozai_lidov, lagrange_points, lagrange_triangle, preset_dt, sitnikov, suvakov,
    trojan, trojan_displaced,
};
use sim::{State, Vec3};

fn rk45(state: State, tolerance: f64) -> Integrator {
    let mut it = Integrator::new(state, Method::Rk45, 1e-3);
    it.tolerance = tolerance;
    it
}

/// 画面の既定：RK45、許容誤差 1e-10、最初の刻み幅はプリセット `id` の既定（画面も sim_preset_dt で同じ値を使う）。
/// 積分法と許容誤差の既定は、ページの入力欄の値と同じであることを e2e で確かめている（tests/e2e/simulator.spec.ts）
fn page_default(state: State, id: u32) -> Integrator {
    let mut it = Integrator::new(state, Method::Rk45, preset_dt(id));
    it.tolerance = 1e-10;
    it
}

/// 画面と同じ条件：プリセット `id` の値を有効数字 10 桁に丸めた初期値を、画面の既定で計算する
fn page(id: u32) -> Integrator {
    page_default(rounded_like_page(by_id(id).unwrap()), id)
}

fn max_position_error(a: &State, b: &State) -> f64 {
    a.positions
        .iter()
        .zip(&b.positions)
        .map(|(p, q)| (*p - *q).norm())
        .fold(0.0, f64::max)
}

/// 画面はプリセットの値を有効数字 10 桁で入力欄に入れ、そこから計算する（toPrecision(10)）。同じ丸めをする
fn rounded_like_page(mut s: State) -> State {
    let r = |x: f64| format!("{x:.9e}").parse::<f64>().unwrap();
    let rv = |v: Vec3| Vec3::new(r(v.x), r(v.y), r(v.z));
    s.masses = s.masses.iter().map(|m| r(*m)).collect();
    s.positions = s.positions.iter().map(|p| rv(*p)).collect();
    s.velocities = s.velocities.iter().map(|v| rv(*v)).collect();
    s
}

/// 2 体 i・j の相対運動の離心率と軌道長半径（束縛されていなければ軌道長半径は負か無限大）
fn two_body_elements(s: &State, i: usize, j: usize) -> (f64, f64) {
    let m = s.masses[i] + s.masses[j];
    let r = s.positions[j] - s.positions[i];
    let v = s.velocities[j] - s.velocities[i];
    let energy = 0.5 * v.dot(v) - m / r.norm();
    let h = r.cross(v);
    let e = (1.0 + 2.0 * energy * h.dot(h) / (m * m)).max(0.0).sqrt();
    (e, -m / (2.0 * energy))
}

/// どのプリセットも入力の検証を通り、全運動量が 0。番号の範囲の外は None
#[test]
fn every_preset_is_valid() {
    for id in 0..PRESET_COUNT {
        let s = by_id(id).unwrap_or_else(|| panic!("プリセット {id} がない"));
        assert_eq!(s.validate(), Ok(()), "プリセット {id}");
        let m: f64 = s.masses.iter().sum();
        assert!(
            s.momentum().norm() / m < 1e-12,
            "プリセット {id} の全運動量"
        );
    }
    assert!(by_id(PRESET_COUNT).is_none());
}

/// テストは番号（画面の option の value）でプリセットを引くので、番号と初期値の対応を確かめる
#[test]
fn preset_ids_match_scenarios() {
    let expected = [
        (4, suvakov(BUTTERFLY_I)),
        (5, suvakov(MOTH_I)),
        (6, suvakov(YIN_YANG_I)),
        (7, suvakov(DRAGONFLY)),
        (8, lagrange_triangle()),
        (9, trojan(JUPITER_MU)),
        (10, trojan(0.05)),
        (11, euler_collinear()),
        (12, kepler16(KEPLER16_PLANET_A)),
        (13, kepler16(KEPLER16_INNER_A)),
        (14, kozai_lidov(KOZAI_INCLINATION_DEG)),
        (15, binary_exchange()),
        (16, binary_ionization()),
        (17, sitnikov()),
        (18, trojan_displaced(JUPITER_MU, TADPOLE_ANGLE_DEG)),
        (19, trojan_displaced(JUPITER_MU, HORSESHOE_ANGLE_DEG)),
    ];
    for (id, state) in expected {
        assert_eq!(by_id(id), Some(state), "プリセット {id}");
    }
}

/// V-14 Šuvakov & Dmitrašinović (2013) の周期解が、1 周期後に初期状態に戻る。角運動量は 0。
/// 初期値は 5〜15 桁なので、戻り方はその精度まで
#[test]
fn v14_suvakov_orbits_return_after_one_period() {
    for (name, orbit, id) in [
        ("蝶 I", BUTTERFLY_I, 4),
        ("蛾 I", MOTH_I, 5),
        ("陰陽 I", YIN_YANG_I, 6),
        ("トンボ", DRAGONFLY, 7),
    ] {
        assert!(suvakov(orbit).angular_momentum().norm() < 1e-15, "{name}");
        // 文献の初期値を高い精度で積分したものと、画面と同じ条件のもの
        let precise = rk45(suvakov(orbit), 1e-13);
        for (label, mut it) in [("高い精度", precise), ("画面の条件", page(id))] {
            let start = it.state.clone();
            it.advance_to(orbit.period);
            let err = max_position_error(&it.state, &start);
            assert!(
                err < 5e-3,
                "{name}（{label}）：1 周期後の位置のずれ {err:e}"
            );
        }
    }
}

/// V-14 周期解は不安定なので、やがて崩れる（蝶 I は t ≈ 130 で周期から外れる：Li & Liao, arXiv:1312.6796）
#[test]
fn v14_butterfly_eventually_departs() {
    let mut it = page(4);
    let start = it.state.clone();
    it.advance_to(BUTTERFLY_I.period * 10.0);
    let early = max_position_error(&it.state, &start);
    it.advance_to(BUTTERFLY_I.period * 40.0);
    let late = max_position_error(&it.state, &start);
    assert!(early < 0.05, "10 周期ではまだ戻る（ずれ {early}）");
    assert!(late > 0.1, "40 周期では外れている（ずれ {late}）");
}

/// 3 つの辺の長さ
fn sides(s: &State) -> [f64; 3] {
    let p = &s.positions;
    [
        (p[0] - p[1]).norm(),
        (p[1] - p[2]).norm(),
        (p[2] - p[0]).norm(),
    ]
}

/// V-15 ラグランジュの正三角形の解（等質量）：はじめは正三角形のまま回るが、不安定なので崩れる
#[test]
fn v15_lagrange_triangle_is_unstable_for_equal_masses() {
    for mut it in [page_default(lagrange_triangle(), 8), page(8)] {
        let period = std::f64::consts::TAU / 3f64.sqrt();
        it.advance_to(period);
        for d in sides(&it.state) {
            assert!((d - 1.0).abs() < 1e-6, "1 周期後の辺の長さ {d}");
        }
        it.advance_to(60.0);
        let worst = sides(&it.state)
            .iter()
            .map(|d| (d - 1.0).abs())
            .fold(0.0, f64::max);
        assert!(
            worst > 0.1,
            "時刻 60 では崩れている（辺の長さのずれ {worst}）"
        );
    }
}

/// 主星から見た、伴星と L4 の天体のなす角（度）
fn trojan_angle(s: &State) -> f64 {
    let (a, b) = (
        s.positions[1] - s.positions[0],
        s.positions[2] - s.positions[0],
    );
    a.cross(b).z.atan2(a.dot(b)).to_degrees()
}

/// V-16 L4 の天体：木星の質量比（μ ≈ 0.00095）では 60° の位置にとどまり、
/// Routh の条件（μ < 約 0.0385）を超える μ = 0.05 では L4 から外れる
#[test]
fn v16_trojan_stability_follows_routh_criterion() {
    let mu_limit = (1.0 - (23.0f64 / 27.0).sqrt()) / 2.0;
    assert!(JUPITER_MU < mu_limit && 0.05 > mu_limit);

    let mut it = page(9);
    let mut t = 0.0;
    while t < 100.0 * std::f64::consts::TAU {
        t += 1.0;
        it.advance_to(t);
        let a = trojan_angle(&it.state);
        assert!((a - 60.0).abs() < 1.0, "木星：時刻 {t} の角度 {a}°");
    }

    let mut it = page(10);
    let mut worst: f64 = 0.0;
    let mut t = 0.0;
    while t < 30.0 * std::f64::consts::TAU {
        t += 1.0;
        it.advance_to(t);
        worst = worst.max((trojan_angle(&it.state) - 60.0).abs());
    }
    assert!(worst > 30.0, "μ = 0.05：60° からのずれの最大 {worst}°");
}

/// V-17 オイラーの一直線の解：はじめは一直線のまま回るが、不安定なので中央の天体が外れていく
#[test]
fn v17_euler_collinear_is_unstable() {
    // 中央の天体が両端を結ぶ線からどれだけ離れているか
    let off_line = |s: &State| {
        let p = &s.positions;
        let (u, w) = (p[2] - p[0], p[1] - p[0]);
        u.cross(w).norm() / u.norm()
    };
    let period = std::f64::consts::TAU / 1.25f64.sqrt();
    let mut it = page(11);
    let (mut first, mut later): (f64, f64) = (0.0, 0.0);
    let mut t = 0.0;
    while t < 30.0 {
        t += 0.05;
        it.advance_to(t);
        let d = off_line(&it.state);
        if t <= period {
            first = first.max(d);
        } else {
            later = later.max(d);
        }
    }
    assert!(first < 1e-3, "1 周期目のずれの最大 {first}");
    assert!(later > 0.1, "時刻 30 までのずれの最大 {later}");
}

/// 2 つの星の重心から惑星（天体 3）までの距離
fn planet_distance(s: &State) -> f64 {
    let m = s.masses[0] + s.masses[1];
    let c = (s.positions[0] * s.masses[0] + s.positions[1] * s.masses[1]) * (1.0 / m);
    (s.positions[2] - c).norm()
}

/// V-18 Kepler-16：実際の軌道（a = 0.7048 AU）の惑星は 2 つの星の周りを回り続け、
/// 安定限界の内側（a = 0.5 AU）に置いた惑星は飛ばされる
#[test]
fn v18_kepler16_planet_stability() {
    let mut it = page(12);
    let mut t = 0.0;
    while t < 1000.0 {
        t += 0.5;
        it.advance_to(t);
        let d = planet_distance(&it.state);
        assert!((0.6..0.8).contains(&d), "時刻 {t}：惑星の距離 {d} AU");
    }

    let mut it = page(13);
    it.advance_to(200.0);
    let d = planet_distance(&it.state);
    assert!(d > 10.0, "内側の惑星は飛ばされる（時刻 200 の距離 {d} AU）");
}

/// 惑星（天体 2）の、星（天体 1）に対する軌道の離心率の、時刻 until までの最大
fn max_inner_eccentricity(mut it: Integrator, until: f64) -> f64 {
    let mut e_max: f64 = 0.0;
    let mut t = 0.0;
    while t < until {
        t += 0.5;
        it.advance_to(t);
        let (e, a) = two_body_elements(&it.state, 0, 1);
        assert!((0.5..2.0).contains(&a), "時刻 {t}：惑星の軌道長半径 {a}");
        e_max = e_max.max(e);
    }
    e_max
}

/// V-19 古在・リドフ振動：傾き 75° では惑星の離心率が 0.05 から 0.9 を超えるまで大きくなり、
/// 臨界の傾き（約 39.2°）より小さい 30° では大きくならない
#[test]
fn v19_kozai_lidov_raises_eccentricity_only_above_critical_inclination() {
    let high = max_inner_eccentricity(page(14), 400.0);
    assert!(high > 0.9, "傾き 75°：離心率の最大 {high}");
    let low = max_inner_eccentricity(page_default(kozai_lidov(30.0), 14), 400.0);
    assert!(low < 0.1, "傾き 30°：離心率の最大 {low}");
}

/// 束縛された 2 体（軌道長半径が正で 10 未満）と、重心から 20 より遠い 1 体に分かれていれば、その組を返す
fn binary_and_escaper(s: &State) -> Option<((usize, usize), usize)> {
    let com = s.center_of_mass();
    [(0, 1, 2), (0, 2, 1), (1, 2, 0)]
        .into_iter()
        .find(|&(i, j, k)| {
            let (_, a) = two_body_elements(s, i, j);
            a > 0.0 && a < 10.0 && (s.positions[k] - com).norm() > 20.0
        })
        .map(|(i, j, k)| ((i, j), k))
}

/// V-20 連星への侵入（Hut & Bahcall 1983 の 3 つの結末のうち 2 つ）。
/// 入れ替わり：天体 3 が天体 1 と連星を作り、天体 2 が弾き出される。
/// ばらばら：全エネルギーが正で、どの 2 体も束縛されず離れていく
#[test]
fn v20_binary_intruder_outcomes() {
    assert!(binary_exchange().energy() < 0.0);
    for mut it in [page_default(binary_exchange(), 15), page(15)] {
        it.advance_to(300.0);
        assert_eq!(binary_and_escaper(&it.state), Some(((0, 2), 1)));
    }
    assert!(binary_ionization().energy() > 0.0);
    for mut it in [page_default(binary_ionization(), 16), page(16)] {
        it.advance_to(300.0);
        for (i, j) in [(0, 1), (0, 2), (1, 2)] {
            let (_, a) = two_body_elements(&it.state, i, j);
            let d = (it.state.positions[i] - it.state.positions[j]).norm();
            assert!(
                a < 0.0 && d > 20.0,
                "天体 {i}・{j}：軌道長半径 {a}、距離 {d}"
            );
        }
    }
}

/// V-21 シトニコフ問題：軽い天体は軸（z 軸）の上にとどまり、上下に振動し続ける（離れていかない）
#[test]
fn v21_sitnikov_body_oscillates_on_axis() {
    let mut it = page(17);
    let (mut z_min, mut z_max) = (f64::MAX, f64::MIN);
    let mut t = 0.0;
    while t < 1000.0 {
        t += 0.1;
        it.advance_to(t);
        let p = it.state.positions[2] - it.state.center_of_mass();
        assert!(
            (p.x * p.x + p.y * p.y).sqrt() < 1e-6,
            "時刻 {t}：軸からのずれ"
        );
        z_min = z_min.min(p.z);
        z_max = z_max.max(p.z);
    }
    assert!(z_max < 1.5 && z_min > -1.5, "z の範囲 {z_min}〜{z_max}");
    assert!(
        z_min < -0.9,
        "軌道面を通り抜けて反対側まで振動する（z の最小 {z_min}）"
    );
}

/// 連星への侵入の全エネルギーは、連星の結合エネルギー −1/2 と、無限遠での相対運動のエネルギー
/// (1/2)(2/3) v_inf²（換算質量 2/3）の和になる。v_inf = speed · v_c、v_c² = 3/2
#[test]
fn binary_intruder_energy_matches_requested_speed() {
    use sim::scenarios::binary_intruder;
    for speed in [0.3, 0.6, 1.0, 2.0] {
        for offset in [0.0, 0.3, 1.0] {
            for phase in [0.0, 1.0, 2.0] {
                let target = -0.5 + speed * speed * 1.5 / 3.0;
                let e = binary_intruder(speed, offset, phase).energy();
                assert!(
                    (e - target).abs() < 1e-12,
                    "speed {speed}、offset {offset}、phase {phase}：全エネルギー {e}、期待 {target}"
                );
            }
        }
    }
}

/// 太陽・木星・トロヤ群のプリセットで、伴星と主星の質量の比が木星と太陽の質量の比になる
#[test]
fn trojan_preset_uses_jupiter_sun_mass_ratio() {
    let s = by_id(9).unwrap();
    let q = s.masses[1] / s.masses[0];
    assert!(
        ((q - JUPITER_SUN_MASS_RATIO) / JUPITER_SUN_MASS_RATIO).abs() < 1e-12,
        "伴星と主星の質量の比 {q}"
    );
}

/// ページの 3 章に書いた時刻が、画面と同じ条件の計算と合う（ページの数値は、ここで測った値を丸めたもの）
#[test]
fn page_text_times_match_page_conditions() {
    // 条件 f を初めて満たす時刻（step ごとに見る）
    let first = |id: u32, f: &dyn Fn(&State) -> bool, step: f64| {
        let mut it = page(id);
        let mut t = 0.0;
        while t < 500.0 {
            t += step;
            it.advance_to(t);
            if f(&it.state) {
                return t;
            }
        }
        f64::NAN
    };
    // 蝶 I は t ≈ 130 で周期から外れる：周期ごとの、初期状態とのずれが初めて 0.1 を超える時刻
    let mut it = page(4);
    let start = it.state.clone();
    let mut k = 1;
    while k < 100 && {
        it.advance_to(BUTTERFLY_I.period * k as f64);
        max_position_error(&it.state, &start) <= 0.1
    } {
        k += 1;
    }
    let t = BUTTERFLY_I.period * k as f64;
    assert!((110.0..150.0).contains(&t), "蝶 I が外れる時刻 {t}");
    // 正三角形は t ≈ 20 で崩れる（辺の長さが 10% ずれる）
    let t = first(8, &|s| sides(s).iter().any(|d| (d - 1.0).abs() > 0.1), 0.05);
    assert!((15.0..25.0).contains(&t), "正三角形が崩れる時刻 {t}");
    // オイラーの解は t ≈ 10 で崩れる（中央の天体が両端を結ぶ線から 0.1 離れる）
    let line = |s: &State| {
        let p = &s.positions;
        let (u, w) = (p[2] - p[0], p[1] - p[0]);
        u.cross(w).norm() / u.norm() > 0.1
    };
    let t = first(11, &line, 0.05);
    assert!((8.0..12.0).contains(&t), "オイラーの解が崩れる時刻 {t}");
    // 古在・リドフ：離心率が 0.9 を超えるのは t ≈ 320
    let t = first(14, &|s| two_body_elements(s, 0, 1).0 > 0.9, 0.5);
    assert!((280.0..360.0).contains(&t), "離心率が 0.9 を超える時刻 {t}");
    // 入れ替わり：t ≈ 30 で天体 1・3 の連星と、去っていく天体 2 に分かれる
    let t = first(15, &|s| binary_and_escaper(s).is_some(), 0.5);
    assert!((25.0..35.0).contains(&t), "入れ替わりが決着する時刻 {t}");
}

/// ページの 3 章に書いた物理量を、作った初期状態から測って確かめる（振り返り 2026-10-18 の T-01）。
/// 帰結（安定・不安定、結末）のテストは、パラメーターの取り違えを見逃すことがあるため
#[test]
fn preset_stated_quantities_hold_in_initial_states() {
    let close =
        |a: f64, b: f64, what: &str| assert!((a - b).abs() < 1e-9, "{what}：{a}（期待 {b}）");
    // 重心からの、i・j の 2 体の重心の位置と速度
    let pair_com = |s: &State, i: usize, j: usize| {
        let m = s.masses[i] + s.masses[j];
        (
            (s.positions[i] * s.masses[i] + s.positions[j] * s.masses[j]) * (1.0 / m),
            (s.velocities[i] * s.masses[i] + s.velocities[j] * s.masses[j]) * (1.0 / m),
        )
    };

    // Kepler-16：星 0.6897・0.20255、a = 0.22431 AU、e = 0.15944、惑星は木星の 0.333 倍、2 つの星の重心から 0.7048 AU の円軌道
    let s = by_id(12).unwrap();
    close(s.masses[0], 0.6897, "Kepler-16 A の質量");
    close(s.masses[1], 0.20255, "Kepler-16 B の質量");
    close(
        s.masses[2] / JUPITER_SUN_MASS_RATIO,
        0.333,
        "惑星の質量（木星の何倍か）",
    );
    let (e, a) = two_body_elements(&s, 0, 1);
    close(a, 0.22431, "連星の軌道長半径");
    close(e, 0.15944, "連星の離心率");
    let (c, v) = pair_com(&s, 0, 1);
    let (r, u) = (s.positions[2] - c, s.velocities[2] - v);
    close(r.norm(), KEPLER16_PLANET_A, "惑星の距離");
    close(r.dot(u), 0.0, "惑星は円軌道（動径方向の速度 0）");
    close(
        u.norm(),
        ((s.masses[0] + s.masses[1]) / r.norm()).sqrt(),
        "惑星の円軌道の速さ",
    );
    close(
        by_id(13)
            .map(|s| (s.positions[2] - pair_com(&s, 0, 1).0).norm())
            .unwrap(),
        KEPLER16_INNER_A,
        "内側の惑星の距離",
    );

    // 古在・リドフ：惑星 0.001 は a = 1、e = 0.05、外側の星 1 は半径 5、軌道面の傾き 75°
    let s = by_id(14).unwrap();
    close(s.masses[1], 0.001, "惑星の質量");
    let (e, a) = two_body_elements(&s, 0, 1);
    close(a, 1.0, "惑星の軌道長半径");
    close(e, 0.05, "惑星の離心率");
    let (c, v) = pair_com(&s, 0, 1);
    let (r, u) = (s.positions[2] - c, s.velocities[2] - v);
    close(r.norm(), 5.0, "外側の星の距離");
    let inner = (s.positions[1] - s.positions[0]).cross(s.velocities[1] - s.velocities[0]);
    let outer = r.cross(u);
    let angle = (inner.dot(outer) / (inner.norm() * outer.norm()))
        .acos()
        .to_degrees();
    close(angle, KOZAI_INCLINATION_DEG, "軌道面の傾き");

    // シトニコフ：連星 0.5・0.5 は a = 1、e = 0.1。軽い天体は重心の軸の上 z = 1 に静止
    let s = by_id(17).unwrap();
    let (e, a) = two_body_elements(&s, 0, 1);
    close(a, 1.0, "連星の軌道長半径");
    close(e, 0.1, "連星の離心率");
    let (c, v) = pair_com(&s, 0, 1);
    close((s.positions[2] - c).z, 1.0, "軽い天体の高さ");
    close((s.velocities[2] - v).norm(), 0.0, "軽い天体は静止");

    // トロヤ群：L4 の天体は、主星・伴星の両方から距離 1（正三角形）
    for id in [9, 10] {
        let s = by_id(id).unwrap();
        for k in [0, 1] {
            close(
                (s.positions[2] - s.positions[k]).norm(),
                1.0,
                "L4 までの距離",
            );
        }
    }

    // L4 からずらしたトロヤ群：2 天体の重心の周りに L4 を 20°・115° 回した位置で、回転座標系では静止
    for (id, angle) in [(18, TADPOLE_ANGLE_DEG), (19, HORSESHOE_ANGLE_DEG)] {
        let s = by_id(id).unwrap();
        let l4 = lagrange_points(JUPITER_MU)[3];
        close(
            synodic_angle(&s) - l4.y.atan2(l4.x).to_degrees(),
            angle,
            "L4 からずらした角度",
        );
        let (c, v) = pair_com(&s, 0, 1);
        let r = s.positions[2] - c;
        close(r.norm(), l4.norm(), "2 天体の重心からの距離（L4 と同じ）");
        // 2 天体の角速度は 1（全質量 1、間隔 1 の円軌道）
        let corotating = Vec3::new(-r.y, r.x, 0.0);
        close(
            (s.velocities[2] - v - corotating).norm(),
            0.0,
            "回転座標系での速さ",
        );
    }

    // 連星への侵入：連星は間隔 1 の円軌道、侵入天体は連星の重心から x 方向に 15 離れたところから
    for id in [15, 16] {
        let s = by_id(id).unwrap();
        let (e, a) = two_body_elements(&s, 0, 1);
        close(a, 1.0, "連星の軌道長半径");
        close(e, 0.0, "連星の離心率");
        close(
            (s.positions[2] - pair_com(&s, 0, 1).0).x,
            -15.0,
            "侵入天体の x",
        );
    }
}

/// 回転座標系での、天体 3 の角度（度、0〜360）。2 天体の重心から見て、伴星の向きから公転の向きに測る（L4 ≈ 60°、L3 ≈ 180°）
fn synodic_angle(s: &State) -> f64 {
    let c = (s.positions[0] * s.masses[0] + s.positions[1] * s.masses[1])
        * (1.0 / (s.masses[0] + s.masses[1]));
    let (a, b) = (s.positions[1] - c, s.positions[2] - c);
    a.cross(b).z.atan2(a.dot(b)).to_degrees().rem_euclid(360.0)
}

/// V-23 ラグランジュ点：5 点とも有効ポテンシャルの勾配が 0（回転座標系で静止できる）。
/// L1〜L3 は x 軸の上の決まった区間にあり、μ が小さいときの近似式（伴星からの距離 ≈ (μ/3)^(1/3)、L3 ≈ −(1 + 5μ/12)）に合う
#[test]
fn v23_lagrange_points_are_equilibria() {
    for mu in [1e-6, JUPITER_MU, 0.01, 0.05, 0.2, 0.5] {
        let [l1, l2, l3, l4, l5] = lagrange_points(mu);
        let (x1, x2) = (-mu, 1.0 - mu);
        for (k, p) in [l1, l2, l3, l4, l5].into_iter().enumerate() {
            let (d1, d2) = (p - Vec3::new(x1, 0.0, 0.0), p - Vec3::new(x2, 0.0, 0.0));
            let grad = p - d1 * ((1.0 - mu) / d1.norm().powi(3)) - d2 * (mu / d2.norm().powi(3));
            assert!(
                grad.norm() < 1e-10,
                "μ = {mu}：L{} の勾配 {}",
                k + 1,
                grad.norm()
            );
        }
        assert!(
            l3.x < x1 && x1 < l1.x && l1.x < x2 && x2 < l2.x,
            "μ = {mu}：L1〜L3 の並び"
        );
        assert!(
            l4.y > 0.0 && l5.y < 0.0,
            "μ = {mu}：L4 は公転の向きに伴星の前"
        );
    }
    for mu in [1e-6, JUPITER_MU] {
        let [l1, l2, l3, ..] = lagrange_points(mu);
        let hill = (mu / 3.0).powf(1.0 / 3.0);
        for (what, d) in [("L1", 1.0 - mu - l1.x), ("L2", l2.x - 1.0 + mu)] {
            assert!(
                (d / hill - 1.0).abs() < 0.1,
                "μ = {mu}：{what} と伴星の距離 {d}（近似 {hill}）"
            );
        }
        let approx = -(1.0 + 5.0 * mu / 12.0);
        assert!(
            (l3.x - approx).abs() < 10.0 * mu * mu,
            "μ = {mu}：L3 {}（近似 {approx}）",
            l3.x
        );
    }
}

/// 画面と同じ条件で、時刻 until まで 0.25 ごとに天体 3 の角度を見て、最小・最大と、mid を横切った時刻を返す
fn synodic_range(id: u32, until: f64, mid: f64) -> (f64, f64, Vec<f64>) {
    let mut it = page(id);
    let (mut lo, mut hi, mut crossings) = (360.0f64, 0.0f64, vec![]);
    let mut prev = synodic_angle(&it.state);
    let mut t = 0.0;
    while t < until {
        t += 0.25;
        it.advance_to(t);
        let a = synodic_angle(&it.state);
        (lo, hi) = (lo.min(a), hi.max(a));
        // 0° と 360° のあいだの飛びは横切りに数えない
        if (prev - mid) * (a - mid) < 0.0 && (a - prev).abs() < 90.0 {
            crossings.push(t);
        }
        prev = a;
    }
    (lo, hi, crossings)
}

/// V-24 L4 からずらしたトロヤ群（木星の μ、画面と同じ条件）。回転座標系での角度（伴星から公転の向きに測る）が、
/// オタマジャクシ（20° ずらす）では 100 周期のあいだ 44°〜80° を周期 約 80 で揺れ、L3（180°）に届かない。
/// 馬蹄形（115° ずらす）では t = 3000 まで約 20°〜340° を往復し、伴星（0°）をまたがない。伴星にいちばん近づく角度は
/// 計算の誤差に敏感で、許容誤差 10⁻¹⁰〜10⁻¹³ で 19.5°〜22.3°（反対側は 337.9°〜340.2°）とばらつくので、範囲は 18°〜24°・336°〜342° で確かめる
#[test]
fn v24_displaced_trojans_librate_around_l4() {
    let (lo, hi, crossings) = synodic_range(18, 100.0 * std::f64::consts::TAU, 62.0);
    assert!(
        (43.0..46.0).contains(&lo) && (79.0..82.0).contains(&hi),
        "オタマジャクシの角度の範囲 {lo:.2}°〜{hi:.2}°"
    );
    let n = crossings.len();
    let period = 2.0 * (crossings[n - 1] - crossings[0]) / (n - 1) as f64;
    assert!(
        (75.0..85.0).contains(&period),
        "オタマジャクシの揺れの周期 {period}"
    );

    let (lo, hi, crossings) = synodic_range(19, 3000.0, 180.0);
    assert!(
        (18.0..24.0).contains(&lo) && (336.0..342.0).contains(&hi),
        "馬蹄形の角度の範囲 {lo:.2}°〜{hi:.2}°"
    );
    assert!(
        crossings.len() >= 10,
        "馬蹄形が L3 をまたいだ回数 {}",
        crossings.len()
    );
}

/// V-23 L1〜L3 は、どの μ（0 < μ < 1）でも、表せる精度の根になっている：返した点の両隣の浮動小数点数で、
/// x 軸の上の有効ポテンシャルの勾配の符号が変わる（勾配が 0 ちょうどでもよい）。
/// μ が小さいと L1・L2 は伴星から (μ/3)^(1/3) ほどしか離れないので、探索の区間を天体から決まった幅だけ離すと解を外す
#[test]
fn v23_collinear_points_are_roots_at_float_resolution() {
    for mu in [
        1e-40,
        1e-20,
        1e-12,
        1e-9,
        JUPITER_MU,
        0.3,
        0.5,
        0.9,
        1.0 - 1e-9,
        1.0 - 1e-12,
    ] {
        let (x1, x2) = (-mu, 1.0 - mu);
        let force = |x: f64| {
            let (d1, d2) = (x - x1, x - x2);
            x - (1.0 - mu) * d1 / d1.abs().powi(3) - mu * d2 / d2.abs().powi(3)
        };
        let [l1, l2, l3, ..] = lagrange_points(mu);
        for (k, x) in [l1.x, l2.x, l3.x].into_iter().enumerate() {
            let (below, at, above) = (force(x.next_down()), force(x), force(x.next_up()));
            assert!(
                at == 0.0 || below.signum() != above.signum(),
                "μ = {mu}：L{} = {x} の両隣の勾配 {below}、{above}",
                k + 1
            );
        }
        assert!(
            l3.x < x1 && x1 < l1.x && l1.x < x2 && x2 < l2.x,
            "μ = {mu}：L1〜L3 の並び"
        );
    }
    // μ が NaN でも止まる（値は NaN でよい）
    let _ = lagrange_points(f64::NAN);
}
