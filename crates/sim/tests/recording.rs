//! 軌跡の記録（docs/plan.md §6：V-30、issue #32）と、時刻に合わせて縮めた刻みのあとの刻み幅（N-03、issue #31）

use sim::integrators::{Integrator, Method, hermite};
use sim::{State, Vec3, scenarios};

/// ページの記録時刻：(from, to) にある 1/60 の倍数と、最後に to（src/lib/trail.ts の recordTimes と同じ決め方）
fn record_times(from: f64, to: f64) -> Vec<f64> {
    let dt = 1.0 / 60.0;
    let mut times: Vec<f64> = ((from / dt).floor() as i64 - 1..=(to / dt).ceil() as i64)
        .map(|k| k as f64 * dt)
        .filter(|&t| t > from && t < to)
        .collect();
    times.push(to);
    times
}

fn integrator(id: u32, method: Method) -> Integrator {
    let state = scenarios::by_id(id).expect("プリセット");
    let mut it = Integrator::new(state, method, scenarios::preset_dt(id));
    it.tolerance = 1e-10;
    it
}

const METHODS: [Method; 3] = [Method::Rk4, Method::Rk45, Method::Leapfrog];
/// 8 の字、傾いた連星＋第 3 天体（3 次元）、L4、Kepler-16、古在・リドフ振動
const PRESETS: [u32; 5] = [0, 3, 9, 12, 14];

/// V-30 記録しながら進めても、刻みは advance_to と同じ：時刻・状態・刻みの数・次の刻み幅がビットまで一致する。
/// 速さ 10・毎秒 60 回の描画（1 回に 1/6）と、速さ 1（1/60）、半端な間隔（0.1234）で、時刻 10 まで
#[test]
fn v30_recording_does_not_change_steps() {
    let mut bad = Vec::new();
    for id in PRESETS {
        for method in METHODS {
            for frame in [1.0 / 6.0, 1.0 / 60.0, 0.1234] {
                let mut plain = integrator(id, method);
                let mut recording = plain.clone();
                let mut until = 0.0;
                while until < 10.0 {
                    let from = until;
                    until += frame;
                    plain.advance_to(until);
                    let times = record_times(from, until);
                    let states = recording.advance_recording(until, &times);
                    if states.len() != times.len() {
                        bad.push(format!(
                            "{id} {method:?} {frame}：記録の数 {} ≠ {}",
                            states.len(),
                            times.len()
                        ));
                    }
                }
                if plain.state != recording.state
                    || plain.time != recording.time
                    || plain.steps != recording.steps
                    || plain.dt != recording.dt
                {
                    bad.push(format!(
                        "{id} {method:?} {frame}：刻みが変わった（刻みの数 {} と {}）",
                        plain.steps, recording.steps
                    ));
                }
            }
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}

/// V-30 補間は、位置が 5 次以下の多項式で動くとき、丸めを除いて正確（両端の位置・速度・加速度から決まる 5 次の多項式）。
/// 刻み幅 3 通り（10⁻³、0.1、1）× 刻みの中の位置 7 通り（両端を含む）× 成分 3 つ
#[test]
fn v30_hermite_is_exact_for_quintic_motion() {
    // 成分 k の位置 p(t) = Σ c[k][d] t^d（d = 0〜5）
    let c = [
        [0.3, -1.2, 0.7, 2.5, -1.1, 0.4],
        [-2.0, 0.5, -0.3, 0.9, 1.7, -0.8],
        [1.0, 0.0, 1.5, -2.2, 0.6, 1.3],
    ];
    let poly = |k: usize, t: f64, deriv: u32| -> f64 {
        (deriv as usize..6)
            .map(|d| {
                let factor: f64 = (0..deriv).map(|j| (d - j as usize) as f64).product();
                c[k][d] * factor * t.powi(d as i32 - deriv as i32)
            })
            .sum()
    };
    let vec =
        |t: f64, deriv: u32| Vec3::new(poly(0, t, deriv), poly(1, t, deriv), poly(2, t, deriv));
    let state = |t: f64| State {
        masses: vec![1.0],
        positions: vec![vec(t, 0)],
        velocities: vec![vec(t, 1)],
    };
    let mut worst: f64 = 0.0;
    for h in [1e-3, 0.1, 1.0] {
        let (t0, t1) = (0.25, 0.25 + h);
        for x in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
            let tau = x * h;
            let s = hermite(&state(t0), &[vec(t0, 2)], &state(t1), &[vec(t1, 2)], h, tau);
            let (p, v) = (vec(t0 + tau, 0), vec(t0 + tau, 1));
            worst = worst
                .max((s.positions[0] - p).norm() / p.norm().max(1.0))
                .max((s.velocities[0] - v).norm() / v.norm().max(1.0));
        }
    }
    assert!(worst < 1e-12, "相対誤差の最大 {worst:e}");
}

/// V-30 補間で足される誤差は、計算そのものの誤差と同じ程度以下。プリセット 5 通り × 積分法 3 通り、
/// 速さ 10 の描画の間隔（1/6）で時刻 10 まで記録し、記録した各時刻の位置を参照（RK45・許容誤差 10⁻¹³ で、その時刻まで
/// 順に進めたもの）と比べる。描画の終わりの時刻（to）の状態は補間ではなく計算器の状態そのものなので、その誤差を計算の
/// 誤差の目安にする：途中の時刻の誤差は、前後の描画の終わりの誤差の大きい方の 2 倍 + 10⁻¹⁰ 以下
#[test]
fn v30_recorded_states_match_direct_integration() {
    let mut bad = Vec::new();
    let mut checked = 0;
    for id in PRESETS {
        for method in METHODS {
            let mut recording = integrator(id, method);
            let mut reference = integrator(id, Method::Rk45);
            reference.tolerance = 1e-13;
            let mut previous_end = 0.0;
            let mut until = 0.0;
            while until < 10.0 {
                let from = until;
                until += 1.0 / 6.0;
                let times = record_times(from, until);
                let states = recording.advance_recording(until, &times);
                let errors: Vec<f64> = times
                    .iter()
                    .zip(&states)
                    .map(|(t, s)| {
                        reference.advance_to(*t);
                        s.positions
                            .iter()
                            .zip(&reference.state.positions)
                            .map(|(p, q)| (*p - *q).norm())
                            .fold(0.0, f64::max)
                    })
                    .collect();
                let end = *errors.last().unwrap();
                let bound = 2.0 * end.max(previous_end) + 1e-10;
                for (t, e) in times.iter().zip(&errors) {
                    checked += 1;
                    if *e > bound {
                        bad.push(format!("{id} {method:?} t={t}：途中 {e:e}、前後の終わり {previous_end:e}・{end:e}"));
                    }
                }
                previous_end = end;
            }
        }
    }
    // 途中の時刻を確かめたこと（5 × 3 × 時刻 10 × 60 ≒ 9000）
    assert!(checked > 8000, "確かめた時刻 {checked}");
    assert!(
        bad.is_empty(),
        "{} 件：{:#?}",
        bad.len(),
        &bad[..bad.len().min(10)]
    );
}

/// V-30 刻みの両端（tau = 0 と tau = h）の補間は、両端の状態そのもの（ビットまで一致）。位置・速度の大きさが極端に違う
/// 組（PR #30 のレビュー 5 回目の入力：1e6 → 1e-10）と、符号が変わる組、同じ大きさの組。描画の終わりの時刻の状態も、
/// 計算器の状態そのもの
#[test]
fn v30_interpolation_endpoints_are_exact() {
    let state = |p: f64, v: f64| State {
        masses: vec![1.0],
        positions: vec![Vec3::new(p, -p, 0.5 * p)],
        velocities: vec![Vec3::new(v, 0.0, -v)],
    };
    let a = [Vec3::default()];
    for (p0, p1, v0, v1, h) in [
        (1e6, 1e-10, 0.0, 0.0, 1.0),
        (-1e6, 1e6, 3.0, -2.0, 0.25),
        (0.3, 0.30000000000000004, 1e-300, 1e300, 1e-3),
        (1.0, 1.0, 1.0, 1.0, 1e-9),
    ] {
        let (s0, s1) = (state(p0, v0), state(p1, v1));
        assert_eq!(hermite(&s0, &a, &s1, &a, h, 0.0), s0, "{p0} → {p1}：始まり");
        assert_eq!(hermite(&s0, &a, &s1, &a, h, h), s1, "{p0} → {p1}：終わり");
    }
    for method in METHODS {
        let mut it = integrator(12, method);
        for k in 1..=30 {
            let until = k as f64 / 6.0;
            let states = it.advance_recording(until, &record_times(until - 1.0 / 6.0, until));
            assert_eq!(states.last(), Some(&it.state), "{method:?} t={until}");
        }
    }
}

/// V-30 記録する時刻の端：いまの時刻以下の時刻はいまの状態、until を超える時刻と NaN は until の状態。空なら何も返さずに進む
#[test]
fn v30_recording_handles_times_outside_the_step() {
    let mut it = integrator(0, Method::Rk45);
    it.advance_to(1.0);
    let now = it.state.clone();
    let states = it.advance_recording(2.0, &[0.5, 1.0, 1.5, 3.0, f64::NAN]);
    assert_eq!(states.len(), 5);
    assert_eq!(states[0], now);
    assert_eq!(states[1], now);
    assert_ne!(states[2], now);
    assert_eq!(states[3], it.state);
    assert_eq!(states[4], it.state);
    assert!((it.time - 2.0).abs() < 1e-12);
    let empty = it.advance_recording(3.0, &[]);
    assert!(empty.is_empty());
    assert!((it.time - 3.0).abs() < 1e-12);
}

/// N-03（issue #31）RK45 で、時刻に合わせて縮めただけの刻み（やり直しなし）のあと、次の刻み幅は縮める前より小さくならない。
/// プリセット 5 通り × 時刻 1〜50 の 50 か所 × いまの刻み幅に対する進める割合 4 通り（0.01、0.1、0.5、0.9）。
/// 進める時間がいまの刻み幅より短いので、1 歩だけで着く。刻みが短く誤差は小さいので、やり直しは起きない（1 歩で着いたことも確かめる）
#[test]
fn n03_step_size_is_kept_after_clipped_step() {
    let mut bad = Vec::new();
    let mut checked = 0;
    for id in PRESETS {
        let mut it = integrator(id, Method::Rk45);
        for k in 1..=50 {
            it.advance_to(k as f64);
            for fraction in [0.01, 0.1, 0.5, 0.9] {
                let mut probe = it.clone();
                let before = probe.dt;
                let steps = probe.steps;
                probe.advance_to(probe.time + before * fraction);
                if probe.steps != steps + 1 {
                    bad.push(format!(
                        "{id} t={k} {fraction}：{} 歩かかった",
                        probe.steps - steps
                    ));
                } else if probe.dt < before {
                    bad.push(format!(
                        "{id} t={k} {fraction}：刻み幅 {before:e} → {:e}",
                        probe.dt
                    ));
                }
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 5 * 50 * 4);
    assert!(
        bad.is_empty(),
        "{} 件：{:#?}",
        bad.len(),
        &bad[..bad.len().min(10)]
    );
}

/// N-03（issue #31）時刻に合わせて縮めた刻みのあとも刻み幅を縮めないので、
/// そのため、時刻を細かく分けて進めても、刻みの数は「1 回で進めたときの数 + 分けた回数」を超えない。
/// プリセット 5 通り × 分ける間隔 3 通り（1/6、0.1234、1）で、時刻 50 まで
#[test]
fn n03_clipped_step_keeps_step_size() {
    let mut bad = Vec::new();
    for id in PRESETS {
        let mut once = integrator(id, Method::Rk45);
        once.advance_to(50.0);
        for interval in [1.0 / 6.0, 0.1234, 1.0] {
            let mut split = integrator(id, Method::Rk45);
            let mut until: f64 = 0.0;
            let mut calls = 0;
            while until < 50.0 {
                until = (until + interval).min(50.0);
                split.advance_to(until);
                calls += 1;
            }
            if split.steps > once.steps + calls {
                bad.push(format!(
                    "{id} {interval}：刻みの数 {}（1 回で {}、分けた回数 {calls}）",
                    split.steps, once.steps
                ));
            }
        }
    }
    assert!(
        bad.is_empty(),
        "{} 件：{:#?}",
        bad.len(),
        &bad[..bad.len().min(10)]
    );
}
