//! 検証（docs/plan.md §6：V-01〜V-05、V-09〜V-11）

use sim::integrators::{Integrator, Method};
use sim::scenarios::{
    CIRCULAR_BINARY_PERIOD, FIGURE_EIGHT_PERIOD, circular_binary, figure_eight,
    figure_eight_vertical, hierarchical_inclined, perturbed, pythagorean,
};
use sim::{State, Vec3};

fn max_position_error(a: &State, b: &State) -> f64 {
    a.positions
        .iter()
        .zip(&b.positions)
        .map(|(p, q)| (*p - *q).norm())
        .fold(0.0, f64::max)
}

fn rk45(state: State, tolerance: f64) -> Integrator {
    let mut it = Integrator::new(state, Method::Rk45, 1e-3);
    it.tolerance = tolerance;
    it
}

/// V-01 二体問題（円軌道）で、1 周期後に元の位置に戻る（解析解との比較）
#[test]
fn v01_circular_binary_returns_after_one_period() {
    // RK45 の誤差は許容誤差（既定 1e-10）で制御され、刻みごとに積み重なるので、その 100 倍を上限にする
    for (method, dt, tol) in [
        (Method::Rk4, 1e-3, 1e-9),
        (Method::Rk45, 1e-3, 1e-8),
        (Method::Leapfrog, 1e-4, 1e-6),
    ] {
        let start = circular_binary();
        let mut it = Integrator::new(start.clone(), method, dt);
        it.advance_to(CIRCULAR_BINARY_PERIOD);
        let err = max_position_error(&it.state, &start);
        assert!(err < tol, "{method:?}: 1 周期後の位置のずれ {err:e}");
    }
}

/// V-02 8 の字の解で、1 周期後に初期状態に戻る
#[test]
fn v02_figure_eight_returns_after_one_period() {
    let start = figure_eight();
    let mut it = rk45(start.clone(), 1e-12);
    it.advance_to(FIGURE_EIGHT_PERIOD);
    let err = max_position_error(&it.state, &start);
    // 初期値と周期は 8〜9 桁で与えられているので、その精度で戻れば十分
    assert!(err < 1e-6, "1 周期後の位置のずれ {err:e}");
}

/// V-03 全運動量はどの積分法でも保たれる（一次の量はルンゲ・クッタ法でも厳密に保たれる）。
/// 全角運動量（二次の量）を厳密に保つのはリープフロッグ法（シンプレクティック）で、RK45 は許容誤差の範囲で保つ。
/// 刻み幅一定の RK4 は、天体が接近すると角運動量がずれる（S-04 で見せる性質）
#[test]
fn v03_momentum_and_angular_momentum_are_conserved() {
    for start in [figure_eight(), pythagorean()] {
        let (p0, l0) = (start.momentum(), start.angular_momentum());
        for (method, dt) in [
            (Method::Rk4, 1e-3),
            (Method::Rk45, 1e-3),
            (Method::Leapfrog, 1e-3),
        ] {
            let mut it = Integrator::new(start.clone(), method, dt);
            it.advance_to(10.0);
            let dp = (it.state.momentum() - p0).norm();
            assert!(dp < 1e-9, "{method:?}: 運動量のずれ {dp:e}");
            let dl = (it.state.angular_momentum() - l0).norm();
            match method {
                Method::Leapfrog => assert!(dl < 1e-10, "Leapfrog: 角運動量のずれ {dl:e}"),
                Method::Rk45 => assert!(dl < 1e-6, "Rk45: 角運動量のずれ {dl:e}"),
                Method::Rk4 => {}
            }
        }
    }
    // 接近のない 8 の字の解なら、RK4 でも角運動量のずれは小さい
    let start = figure_eight();
    let mut it = Integrator::new(start.clone(), Method::Rk4, 1e-3);
    it.advance_to(10.0);
    assert!((it.state.angular_momentum() - start.angular_momentum()).norm() < 1e-9);
}

/// S-04 刻み幅一定の RK4 は、接近のあるピタゴラスの三体問題では角運動量が大きくずれる
#[test]
fn s04_fixed_step_rk4_drifts_in_close_encounters() {
    let start = pythagorean();
    let mut it = Integrator::new(start.clone(), Method::Rk4, 1e-3);
    it.advance_to(10.0);
    assert!((it.state.angular_momentum() - start.angular_momentum()).norm() > 1e-3);
}

/// V-04 全エネルギーのずれが、積分法ごとに想定の範囲に収まる
#[test]
fn v04_energy_error_is_within_expected_bounds() {
    let relative = |it: &Integrator, e0: f64| ((it.state.energy() - e0) / e0).abs();

    // 8 の字の解を 10 周期：どの方法でも小さい
    let start = figure_eight();
    let e0 = start.energy();
    // RK45 は許容誤差（1e-10）で制御されるので、10 周期で積み重なった分を見込んで 1e-7 を上限にする
    for (method, dt, bound) in [
        (Method::Rk4, 1e-3, 1e-9),
        (Method::Rk45, 1e-3, 1e-7),
        (Method::Leapfrog, 1e-3, 1e-5),
    ] {
        let mut it = Integrator::new(start.clone(), method, dt);
        it.advance_to(10.0 * FIGURE_EIGHT_PERIOD);
        assert!(
            relative(&it, e0) < bound,
            "{method:?}: エネルギーの相対誤差 {:e}",
            relative(&it, e0)
        );
    }

    // リープフロッグ法はシンプレクティックなので、長時間でもずれが増え続けない。
    // ずれは 1 周期の中で揺れ動くので、ある瞬間の値ではなく期間中の最大値で比べる（100 周期の最大が 10 周期の最大と同程度）
    let max_error = |periods: f64| {
        let mut it = Integrator::new(start.clone(), Method::Leapfrog, 1e-2);
        let (mut t, mut worst) = (0.0, 0.0f64);
        while t < periods * FIGURE_EIGHT_PERIOD {
            t += 0.25;
            it.advance_to(t);
            worst = worst.max(relative(&it, e0));
        }
        worst
    };
    let (worst10, worst100) = (max_error(10.0), max_error(100.0));
    assert!(
        worst100 < 1.5 * worst10,
        "10 周期の最大 {worst10:e}、100 周期の最大 {worst100:e}"
    );

    // ピタゴラスの三体問題（接近がある）：刻み幅を自動で変える RK45 は小さく保てる
    let start = pythagorean();
    let e0 = start.energy();
    let mut it = rk45(start, 1e-12);
    it.advance_to(70.0);
    assert!(
        relative(&it, e0) < 1e-7,
        "RK45：エネルギーの相対誤差 {:e}",
        relative(&it, e0)
    );
}

/// V-05 ピタゴラスの三体問題で、最も軽い天体（質量 3）が弾き飛ばされ、残りの 2 つが連星になる
/// （Szebehely & Peters 1967 の結果と同じ）
#[test]
fn v05_pythagorean_lightest_body_escapes() {
    let mut it = rk45(pythagorean(), 1e-12);
    it.advance_to(100.0);
    let s = &it.state;
    let com = s.center_of_mass();
    let dist = |i: usize| (s.positions[i] - com).norm();
    assert!(dist(0) > 50.0, "質量 3 の天体の重心からの距離 {}", dist(0));
    assert!(
        (s.positions[1] - s.positions[2]).norm() < 2.0,
        "質量 4 と 5 は連星として近くにいる"
    );
    // 運動量のつり合い：質量 3 の天体と、質量 9 の連星は、重心から 3 : 1 の距離にある
    let binary_com = (s.positions[1] * 4.0 + s.positions[2] * 5.0) * (1.0 / 9.0);
    assert!(((binary_com - com).norm() * 3.0 - dist(0)).abs() < 1.0);
}

/// S-03 カオス：10⁻⁶ のずれが、やがて大きな違いになる
#[test]
fn s03_tiny_perturbation_grows() {
    let mut a = rk45(pythagorean(), 1e-12);
    let mut b = rk45(perturbed(pythagorean(), 1e-6), 1e-12);
    a.advance_to(70.0);
    b.advance_to(70.0);
    assert!(max_position_error(&a.state, &b.state) > 1e-2);
}

#[test]
fn vector_basics() {
    assert_eq!(Vec3::new(3.0, 4.0, 0.0).norm(), 5.0);
}

/// 時刻を細かく何度も進めても止まらない（残り時間が丸め誤差より小さくなっても無限ループにならない）
#[test]
fn advance_to_terminates_for_many_small_calls() {
    for method in [Method::Rk4, Method::Rk45, Method::Leapfrog] {
        let mut it = Integrator::new(figure_eight(), method, 1e-2);
        let mut t = 0.0;
        for _ in 0..2000 {
            t += 0.1 + 1e-13;
            it.advance_to(t);
        }
        assert!((it.time - t).abs() < 1e-9);
    }
}

/// S-05 入力の検証：質量は正、位置と速度は有限、天体は重ならない
#[test]
fn s05_invalid_initial_conditions_are_rejected() {
    use sim::StateError;
    assert_eq!(figure_eight().validate(), Ok(()));
    assert_eq!(pythagorean().validate(), Ok(()));
    let mut s = figure_eight();
    s.masses[1] = 0.0;
    assert_eq!(s.validate(), Err(StateError::Mass));
    let mut s = figure_eight();
    s.masses[2] = -1.0;
    assert_eq!(s.validate(), Err(StateError::Mass));
    let mut s = figure_eight();
    s.velocities[0].x = f64::NAN;
    assert_eq!(s.validate(), Err(StateError::NotFinite));
    let mut s = figure_eight();
    s.positions[1] = s.positions[0];
    assert_eq!(s.validate(), Err(StateError::Overlap));
}

/// N-07 計算できる値の範囲の端の格子（質量 3 通りの 3 天体 × 間隔 3 通り × 向き 3 通り × 速度 3 通り）で、
/// 入力の検証を通り、初期状態の加速度・全エネルギー・全運動量・全角運動量・重心が有限で、加速度と位置エネルギーが 0 に落ちない
#[test]
fn n07_range_edges_are_accepted_and_finite() {
    use sim::{MAX_COMPONENT, MAX_MASS, MIN_MASS, MIN_SEPARATION};
    let masses = [MIN_MASS, 1.0, MAX_MASS];
    let directions = [
        Vec3::new(1.0, 0.0, 0.0),
        Vec3::new(1.0, 1.0, 0.0),
        Vec3::new(1.0, -2.0, 3.0),
    ];
    let mut checked = 0;
    for &m0 in &masses {
        for &m1 in &masses {
            for &m2 in &masses {
                for dir in directions {
                    let unit = dir * (1.0 / dir.norm());
                    // いちばん大きい成分が 1 になる向き（両端を ±MAX_COMPONENT に置くため）
                    let largest = dir.x.abs().max(dir.y.abs()).max(dir.z.abs());
                    let corner = dir * (MAX_COMPONENT / largest);
                    let placements = [
                        (Vec3::default(), unit * (MIN_SEPARATION * (1.0 + 1e-6))),
                        (Vec3::default(), unit),
                        (corner * -1.0, corner),
                    ];
                    let speeds = [
                        Vec3::default(),
                        Vec3::new(0.0, MAX_COMPONENT, 0.0),
                        Vec3::new(MAX_COMPONENT, -MAX_COMPONENT, MAX_COMPONENT),
                    ];
                    for (p0, p1) in placements {
                        for v in speeds {
                            let s = State {
                                masses: vec![m0, m1, m2],
                                positions: vec![p0, p1, Vec3::new(0.3, 0.7, -0.5)],
                                velocities: vec![v, v * -1.0, Vec3::new(0.0, 0.0, MAX_COMPONENT)],
                            };
                            let name =
                                format!("質量 {:?}・位置 {p0:?} {p1:?}・速度 {v:?}", s.masses);
                            assert_eq!(s.validate(), Ok(()), "{name}");
                            let finite =
                                |v: Vec3| v.x.is_finite() && v.y.is_finite() && v.z.is_finite();
                            for a in s.accelerations(&s.positions) {
                                assert!(finite(a) && a.norm() > 0.0, "{name}：加速度 {a:?}");
                            }
                            // 位置エネルギーは、速度を 0 にした状態の全エネルギー（運動エネルギーとの和では丸めで消えることがあるため）
                            let at_rest = State {
                                velocities: vec![Vec3::default(); 3],
                                ..s.clone()
                            };
                            let potential = at_rest.energy();
                            assert!(
                                s.energy().is_finite() && potential < 0.0 && potential.is_normal(),
                                "{name}：エネルギー"
                            );
                            assert!(
                                finite(s.momentum()) && finite(s.angular_momentum()),
                                "{name}"
                            );
                            // 重心は Σ m_i r_i / Σ m_i（この範囲では直接計算してもあふれない）
                            let total: f64 = s.masses.iter().sum();
                            let expected = (0..3)
                                .fold(Vec3::default(), |c, i| c + s.positions[i] * s.masses[i])
                                * (1.0 / total);
                            let com = s.center_of_mass();
                            assert!(
                                finite(com)
                                    && (com - expected).norm() <= 1e-12 * (1.0 + expected.norm()),
                                "{name}：重心 {com:?}"
                            );
                            checked += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(checked, 27 * 3 * 3 * 3);
}

/// N-07 範囲のすぐ外（端の隣の浮動小数点数）と、あふれる大きさ（1e308）は、理由をつけて拒否する
#[test]
fn n07_values_outside_range_are_rejected() {
    use sim::{MAX_COMPONENT, MAX_MASS, MIN_MASS, StateError};
    let two = || State {
        masses: vec![1.0, 1.0],
        positions: vec![Vec3::new(0.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0)],
        velocities: vec![Vec3::default(), Vec3::default()],
    };
    for m in [
        MIN_MASS.next_down(),
        MAX_MASS.next_up(),
        1e308,
        f64::INFINITY,
        f64::NAN,
        0.0,
    ] {
        let mut s = two();
        s.masses[1] = m;
        assert_eq!(s.validate(), Err(StateError::Mass), "質量 {m}");
    }
    // 質量 1e308・1e308（issue #16 の入力）
    let mut s = two();
    s.masses = vec![1e308, 1e308];
    assert_eq!(s.validate(), Err(StateError::Mass));
    for c in [MAX_COMPONENT.next_up(), -MAX_COMPONENT.next_up(), 1e308] {
        for k in 0..3 {
            let set = |v: &mut Vec3| match k {
                0 => v.x = c,
                1 => v.y = c,
                _ => v.z = c,
            };
            let mut s = two();
            set(&mut s.positions[0]);
            assert_eq!(s.validate(), Err(StateError::Range), "位置の成分 {k} = {c}");
            let mut s = two();
            set(&mut s.velocities[1]);
            assert_eq!(s.validate(), Err(StateError::Range), "速度の成分 {k} = {c}");
        }
    }
}

/// N-08 重心は、質量の和があふれる・極小のときも Σ m_i r_i / Σ m_i に一致する（期待値は質量の比から求める）
#[test]
fn n08_center_of_mass_with_extreme_masses() {
    let p = [Vec3::new(0.0, 0.0, 0.0), Vec3::new(1.0, 2.0, 0.0)];
    for (m0, m1) in [
        (1e308, 1e308),
        (1e308, 1.0),
        (1e-300, 3e-300),
        (5e-324, 5e-324),
        (1.0, 1e308),
    ] {
        let s = State {
            masses: vec![m0, m1],
            positions: p.to_vec(),
            velocities: vec![Vec3::default(); 2],
        };
        let q = m1 / m0;
        let mu = if q.is_finite() { q / (1.0 + q) } else { 1.0 };
        let com = s.center_of_mass();
        let expected = p[1] * mu;
        assert!(
            (com - expected).norm() < 1e-12,
            "質量 {m0}・{m1}：重心 {com:?}、正しくは {expected:?}"
        );
    }
    // 位置が極大でも、重心は有限で 2 天体の間にある
    let s = State {
        masses: vec![1.0, 3.0],
        positions: vec![Vec3::new(-1e308, 0.0, 0.0), Vec3::new(1e308, 0.0, 0.0)],
        velocities: vec![Vec3::default(); 2],
    };
    let com = s.center_of_mass();
    assert!(
        (com.x - 0.5e308).abs() < 1e295 && com.y == 0.0 && com.z == 0.0,
        "{com:?}"
    );
}

/// N-08 重心は、どの有限の質量と位置でも、有限で、各成分が位置の最小と最大の間にある（重みの和の丸めであふれない）。
/// 質量の組 6 通り × 位置の組 6 通り × 成分 3 通りの格子
#[test]
fn n08_center_of_mass_stays_between_positions() {
    let max = f64::MAX;
    let masses = [
        [1.0, 1.0],
        [1.0, 1e-12],
        [5.043479608760427e-146, 2.434954721656867e-158], // PR #19 のレビュー 1 回目の入力
        [1e308, 1e-308],
        [f64::MIN_POSITIVE, 5e-324],
        [3.0, 7.0],
    ];
    let pairs = [
        (max, max),
        (-max, -max),
        (max, -max),
        (max, max * 0.999),
        (0.0, max),
        (1e-300, 3e-300),
    ];
    let mut checked = 0;
    for m in masses {
        for (a, b) in pairs {
            for k in 0..3 {
                let place = |c: f64| match k {
                    0 => Vec3::new(c, 1.0, 0.0),
                    1 => Vec3::new(1.0, c, 0.0),
                    _ => Vec3::new(0.0, 1.0, c),
                };
                let s = State {
                    masses: m.to_vec(),
                    positions: vec![place(a), place(b)],
                    velocities: vec![Vec3::default(); 2],
                };
                let com = s.center_of_mass();
                let c = [com.x, com.y, com.z][k];
                let name = format!("質量 {m:?}・位置の成分 {k} = {a:e}, {b:e}：重心 {com:?}");
                assert!(c.is_finite() && a.min(b) <= c && c <= a.max(b), "{name}");
                // 同じ位置なら、重心はその位置
                if a == b {
                    assert_eq!(c, a, "{name}");
                }
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 6 * 6 * 3);
}

/// 誤差のない和（a + b = s + e）
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    (s, (a - (s - bb)) + (b - bb))
}

/// Σ a_i b_i を、倍の精度で求める（Ogita・Rump・Oishi の Dot2。積の誤差は mul_add で正確に求める）
fn dot2(a: &[f64], b: &[f64]) -> f64 {
    let (mut s, mut c) = (0.0, 0.0);
    for (&x, &y) in a.iter().zip(b) {
        let p = x * y;
        let ep = x.mul_add(y, -p);
        let (t, es) = two_sum(s, p);
        s = t;
        c += ep + es;
    }
    s + c
}

/// 2^k（2^±1024 を 1 回で作るとあふれるので、2 回に分けて掛ける）
fn pow2(k: i32) -> f64 {
    2f64.powi(k / 2) * 2f64.powi(k - k / 2)
}

/// 最大の絶対値 v が 1 程度になる 2 の累乗の倍率（丸めなし）。非正規化数の v でも、倍率は 2^1000 までにする
fn unit_scale(v: f64) -> f64 {
    if v == 0.0 {
        1.0
    } else {
        pow2((-(v.log2().ceil() as i32)).min(1000))
    }
}

/// Σ m_i x_i / Σ m_i の参照値。質量と位置を 2 の累乗の倍率で 1 程度にそろえてから、倍の精度（Dot2）で求め、最後に倍率を戻す。
/// 真の値との差は 4ε × 位置の絶対値の最大 + 2⁻¹⁰⁷⁴ 以下（Dot2 と割り算の誤差、最後に非正規化数へ丸める誤差、
/// 倍率をかけた位置のうち 0 に落ちる小さい項（位置の絶対値の最大 × 2⁻¹⁰⁷⁴ 未満））
fn center_reference(m: &[f64], x: &[f64]) -> f64 {
    let largest = x.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    let (mk, xk) = (
        unit_scale(m.iter().fold(0.0_f64, |a, &v| a.max(v))),
        unit_scale(largest),
    );
    let ms: Vec<f64> = m.iter().map(|v| v * mk).collect();
    let xs: Vec<f64> = x.iter().map(|v| v * xk).collect();
    let total = ms.iter().fold((0.0, 0.0), |(s, c), &v| {
        let (t, e) = two_sum(s, v);
        (t, c + e)
    });
    dot2(&ms, &xs) / (total.0 + total.1) / xk
}

/// 重心の x 成分が N-08 の上限（10⁻¹⁴ × 位置の絶対値の最大 + 4 × 2⁻¹⁰⁷⁴）の中にあるか。参照値そのものの誤差
/// （center_reference の説明）を上限から引いた幅で比べるので、この比較を満たせば、真の値との差は上限以下
fn center_within_bound(m: &[f64], x: &[f64]) -> Result<(), String> {
    let s = State {
        masses: m.to_vec(),
        positions: x.iter().map(|&c| Vec3::new(c, 0.0, 0.0)).collect(),
        velocities: vec![Vec3::default(); m.len()],
    };
    let com = s.center_of_mass().x;
    let expected = center_reference(m, x);
    let largest = x.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
    let tiny = f64::from_bits(1); // 2⁻¹⁰⁷⁴
    let allowed = (1e-14 - 4.0 * f64::EPSILON) * largest + 3.0 * tiny;
    if com.is_finite() && (com - expected).abs() <= allowed {
        Ok(())
    } else {
        Err(format!(
            "質量 {m:?}・位置 {x:?}：重心 {com:e}、参照値 {expected:e}"
        ))
    }
}

/// N-08 重心と Σ m_i x_i / Σ m_i の差は、各成分で 10⁻¹⁴ × 位置の成分の絶対値の最大 + 4 × 2⁻¹⁰⁷⁴ 以下。
/// 3 天体の質量の組 4 通り × 位置の x 成分の組 512 通り（8 つの値の 3 天体への並び。±極大が打ち消し合う組、
/// 非正規化数の位置を含む）と、PR #19 のレビュー 2・3 回目の入力で確かめる
#[test]
fn n08_center_of_mass_error_is_bounded() {
    let (max, tiny) = (f64::MAX, f64::from_bits(1));
    let masses = [
        [1.0, 1.0, 1.0],
        [1.0, 1e-12, 1e12],
        [5.043479608760427e-146, 2.434954721656867e-158, 1.0],
        [1e308, 1e308, 1.0],
    ];
    let values = [max, -max, 1e-300, 1.0, -0.5, 0.0, tiny, -3.0 * tiny];
    let mut checked = 0;
    for m in masses {
        for &x0 in &values {
            for &x1 in &values {
                for &x2 in &values {
                    let result = center_within_bound(&m, &[x0, x1, x2]);
                    assert!(result.is_ok(), "{}", result.unwrap_err());
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 4 * 512);
    // レビュー 2 回目の入力（±極大が打ち消し合う）と、3 回目の入力（非正規化数の位置。真の値 2⁻¹⁰⁷⁴ / 3 は表せない）
    for (m, x) in [
        (vec![1.0, 1.0, 1.0], vec![max, -max, 1e-300]),
        (vec![1.0, 2.0], vec![tiny, 0.0]),
    ] {
        let result = center_within_bound(&m, &x);
        assert!(result.is_ok(), "{}", result.unwrap_err());
    }
}

/// N-06 刻み幅を細かくすると、RK4 の誤差は小さくなる（4 次なので、刻み幅を 1/2 にすると誤差はおよそ 1/16）
#[test]
fn n06_smaller_step_reduces_rk4_error() {
    let start = figure_eight();
    let e0 = start.energy();
    let error = |dt: f64| {
        let mut it = Integrator::new(start.clone(), Method::Rk4, dt);
        it.advance_to(FIGURE_EIGHT_PERIOD);
        ((it.state.energy() - e0) / e0).abs()
    };
    let (coarse, fine) = (error(0.02), error(0.01));
    // 理屈では 1/16。丸め誤差などを見込んで 1/8 より小さくなることを確かめる
    assert!(
        fine < coarse / 8.0,
        "dt=0.02: {coarse:e}, dt=0.01: {fine:e}"
    );
}

/// 回転行列（x 軸の周りに a、z 軸の周りに b）で、状態を空間の中で回す
fn rotated(mut s: State, a: f64, b: f64) -> State {
    let rot = |v: Vec3| {
        let v1 = Vec3::new(
            v.x,
            v.y * a.cos() - v.z * a.sin(),
            v.y * a.sin() + v.z * a.cos(),
        );
        Vec3::new(
            v1.x * b.cos() - v1.y * b.sin(),
            v1.x * b.sin() + v1.y * b.cos(),
            v1.z,
        )
    };
    s.positions = s.positions.into_iter().map(rot).collect();
    s.velocities = s.velocities.into_iter().map(rot).collect();
    s
}

/// V-09 8 の字の解を空間の中で傾けても、1 周期後に初期状態に戻る（3 次元の計算が回転に依らない）
#[test]
fn v09_tilted_figure_eight_returns_after_one_period() {
    let start = rotated(figure_eight(), 0.7, 0.3);
    let mut it = rk45(start.clone(), 1e-12);
    it.advance_to(FIGURE_EIGHT_PERIOD);
    assert!(max_position_error(&it.state, &start) < 1e-6);
}

/// V-09 傾いた面内の二体の円軌道が、1 周期後に元の位置に戻る
#[test]
fn v09_inclined_circular_binary_returns_after_one_period() {
    let start = rotated(circular_binary(), 1.1, -0.4);
    for (method, dt, tol) in [
        (Method::Rk4, 1e-3, 1e-9),
        (Method::Rk45, 1e-3, 1e-8),
        (Method::Leapfrog, 1e-4, 1e-6),
    ] {
        let mut it = Integrator::new(start.clone(), method, dt);
        it.advance_to(CIRCULAR_BINARY_PERIOD);
        assert!(max_position_error(&it.state, &start) < tol, "{method:?}");
    }
}

/// V-10 N 体（5 体、3 次元）でも、全運動量と全角運動量（ベクトル）が保たれる
#[test]
fn v10_five_bodies_conserve_momentum_and_angular_momentum() {
    let start = State {
        masses: vec![1.0, 0.8, 0.5, 0.3, 0.2],
        positions: vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(2.0, 0.1, -0.2),
            Vec3::new(-1.5, 1.0, 0.3),
            Vec3::new(0.3, -2.5, 0.5),
            Vec3::new(-0.4, 0.2, 3.0),
        ],
        velocities: vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(0.0, 0.6, 0.1),
            Vec3::new(-0.3, -0.5, 0.0),
            Vec3::new(0.6, 0.0, -0.1),
            Vec3::new(0.0, -0.4, 0.0),
        ],
    };
    assert_eq!(start.validate(), Ok(()));
    let (p0, l0) = (start.momentum(), start.angular_momentum());
    let mut it = Integrator::new(start, Method::Leapfrog, 1e-3);
    it.advance_to(5.0);
    assert!((it.state.momentum() - p0).norm() < 1e-9);
    assert!((it.state.angular_momentum() - l0).norm() < 1e-10);
}

/// V-11 3 次元のプリセット：全運動量が 0、平面から外れた動きをする。傾いた階層的三体は、第 3 天体が連星から離れていかない
#[test]
fn v11_three_dimensional_presets() {
    for start in [figure_eight_vertical(), hierarchical_inclined()] {
        assert_eq!(start.validate(), Ok(()));
        assert!(start.momentum().norm() < 1e-12);
        let mut it = rk45(start, 1e-11);
        let mut max_z: f64 = 0.0;
        let mut t = 0.0;
        while t < 30.0 {
            t += 0.5;
            it.advance_to(t);
            max_z = max_z.max(
                it.state
                    .positions
                    .iter()
                    .map(|p| p.z.abs())
                    .fold(0.0, f64::max),
            );
        }
        assert!(
            max_z > 0.05,
            "平面から外れた動きをする（最大の |z| = {max_z}）"
        );
    }
    let mut it = rk45(hierarchical_inclined(), 1e-11);
    let mut t = 0.0;
    while t < 100.0 {
        t += 1.0;
        it.advance_to(t);
        let com = it.state.center_of_mass();
        let d = (it.state.positions[2] - com).norm();
        assert!(
            (3.0..8.0).contains(&d),
            "時刻 {t}：第 3 天体の重心からの距離 {d}"
        );
    }
}

/// 天体の数は 2〜8
#[test]
fn body_count_is_limited() {
    use sim::{MAX_BODIES, StateError};
    let mut one = circular_binary();
    one.masses.truncate(1);
    one.positions.truncate(1);
    one.velocities.truncate(1);
    assert_eq!(one.validate(), Err(StateError::Shape));
    let n = MAX_BODIES + 1;
    let many = State {
        masses: vec![1.0; n],
        positions: (0..n).map(|i| Vec3::new(i as f64, 0.0, 0.0)).collect(),
        velocities: vec![Vec3::default(); n],
    };
    assert_eq!(many.validate(), Err(StateError::Shape));
}

/// V-11 3 次元の運動でも、全エネルギーが保たれる（z 方向の成分を含めて計算していること）
#[test]
fn v11_energy_is_conserved_in_three_dimensions() {
    let tilted = rotated(figure_eight(), 0.9, 0.4);
    for start in [figure_eight_vertical(), hierarchical_inclined(), tilted] {
        let e0 = start.energy();
        let mut it = rk45(start, 1e-11);
        it.advance_to(20.0);
        let rel = ((it.state.energy() - e0) / e0).abs();
        assert!(rel < 1e-8, "全エネルギーの相対誤差 {rel:e}");
    }
    // 回しても全エネルギーは変わらない（運動エネルギーに z 成分が入っていること）
    assert!((rotated(figure_eight(), 0.9, 0.4).energy() - figure_eight().energy()).abs() < 1e-12);
}
