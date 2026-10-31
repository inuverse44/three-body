//! WebAssembly の窓口（docs/plan.md §4：C-02）。wasm-bindgen などは使わず、関数を直接公開する。
//! 初期値は、JavaScript が入力用の配列（天体ごとに 質量・x・y・z・vx・vy・vz）に書き込み、sim_init で読み込む（S-05）。
//! 有名シナリオの値は sim_load_preset が入力用の配列に書き出す（値の出どころを Rust の 1 か所にまとめる）。
//! 計算器は最大 SLOTS 個まで同時に持てる（カオスの比較で 2 つ、積分法の比較で 3 つ使う）。

use std::cell::RefCell;

use crate::integrators::{Integrator, Method, RECORD_CAPACITY};
use crate::{
    MAX_BODIES, MAX_COMPONENT, MAX_MASS, MIN_MASS, MIN_SEPARATION, State, StateError, Vec3,
    scenarios,
};

const SLOTS: usize = 5;
/// 1 天体あたりの入力：質量、x、y、z、vx、vy、vz
const FIELDS: usize = 7;

struct Slot {
    sim: Option<Integrator>,
    /// 天体ごとの x, y, z（長さは固定なので、アドレスは変わらない）
    out: [f64; MAX_BODIES * 3],
    /// 天体ごとの vx, vy, vz
    vout: [f64; MAX_BODIES * 3],
    /// 直前の sim_advance_recording で記録した状態（記録した時刻の順）
    samples: Vec<State>,
}

thread_local! {
    static SLOTS_CELL: RefCell<Vec<Slot>> = RefCell::new(
        (0..SLOTS)
            .map(|_| Slot { sim: None, out: [0.0; MAX_BODIES * 3], vout: [0.0; MAX_BODIES * 3], samples: Vec::new() })
            .collect(),
    );
    static INPUT: RefCell<[f64; MAX_BODIES * FIELDS]> = const { RefCell::new([0.0; MAX_BODIES * FIELDS]) };
    /// 記録する時刻（JavaScript が書き込む）
    static TIMES: RefCell<Vec<f64>> = RefCell::new(vec![0.0; RECORD_CAPACITY]);
}

fn with_slot<R>(slot: u32, f: impl FnOnce(&mut Slot) -> R) -> Option<R> {
    SLOTS_CELL.with(|cell| cell.borrow_mut().get_mut(slot as usize).map(f))
}

/// 扱える天体の数の上限
#[unsafe(no_mangle)]
pub extern "C" fn sim_max_bodies() -> u32 {
    MAX_BODIES as u32
}

/// 計算できる値の範囲（N-07。画面の文に使う）：0 = 質量の下限、1 = 質量の上限、2 = 位置と速度の各成分の絶対値の上限、3 = 2 天体の間隔の下限
#[unsafe(no_mangle)]
pub extern "C" fn sim_limit(kind: u32) -> f64 {
    match kind {
        0 => MIN_MASS,
        1 => MAX_MASS,
        2 => MAX_COMPONENT,
        3 => MIN_SEPARATION,
        _ => f64::NAN,
    }
}

/// 入力用の配列のアドレス（JavaScript が Float64Array で書き込む）
#[unsafe(no_mangle)]
pub extern "C" fn sim_input() -> *mut f64 {
    INPUT.with(|cell| cell.borrow_mut().as_mut_ptr())
}

/// 有名シナリオの初期値を、入力用の配列に書き出し、天体の数を返す（失敗したら 0）。
/// 番号と内容の対応は scenarios::by_id（0〜3 は 8 の字の解、ピタゴラス、8 の字＋垂直の速度、傾いた連星＋第 3 天体。
/// 4〜19 は研究済みの周期解、ラグランジュの解、惑星、連星への侵入、シトニコフ問題、L4 からずらしたトロヤ群）
#[unsafe(no_mangle)]
pub extern "C" fn sim_load_preset(scenario: u32) -> u32 {
    let Some(state) = scenarios::by_id(scenario) else {
        return 0;
    };
    INPUT.with(|cell| {
        let mut input = cell.borrow_mut();
        for i in 0..state.len() {
            let (p, v) = (state.positions[i], state.velocities[i]);
            input[i * FIELDS..(i + 1) * FIELDS].copy_from_slice(&[
                state.masses[i],
                p.x,
                p.y,
                p.z,
                v.x,
                v.y,
                v.z,
            ]);
        }
    });
    state.len() as u32
}

/// プリセットの最初の刻み幅（scenarios::preset_dt）。画面の「刻み幅 h」の既定にする
#[unsafe(no_mangle)]
pub extern "C" fn sim_preset_dt(scenario: u32) -> f64 {
    scenarios::preset_dt(scenario)
}

/// 入力用の配列の先頭 n 天体の初期値で計算器を用意する。method：0 = RK4、1 = RK45、2 = リープフロッグ法。
/// dt は刻み幅（RK45 では最初に試す刻み幅）、tolerance は RK45 の許容誤差。
/// 戻り値：1 = 成功、0 = 天体の数・積分法・刻み幅・許容誤差の誤り、2 = 質量の誤り、3 = 位置や速度が有限でない、4 = 天体が重なっている、5 = 位置や速度の成分が範囲の外
#[unsafe(no_mangle)]
pub extern "C" fn sim_init(slot: u32, n: u32, method: u32, dt: f64, tolerance: f64) -> u32 {
    let n = n as usize;
    let Some(method) = Method::from_id(method) else {
        return 0;
    };
    if !(2..=MAX_BODIES).contains(&n)
        || !(dt > 0.0 && dt.is_finite() && tolerance > 0.0 && tolerance.is_finite())
    {
        return 0;
    }
    let state = INPUT.with(|cell| {
        let input = cell.borrow();
        let body = |i: usize| &input[i * FIELDS..(i + 1) * FIELDS];
        State {
            masses: (0..n).map(|i| body(i)[0]).collect(),
            positions: (0..n)
                .map(|i| Vec3::new(body(i)[1], body(i)[2], body(i)[3]))
                .collect(),
            velocities: (0..n)
                .map(|i| Vec3::new(body(i)[4], body(i)[5], body(i)[6]))
                .collect(),
        }
    });
    match state.validate() {
        Ok(()) => {}
        Err(StateError::Mass) => return 2,
        Err(StateError::NotFinite) => return 3,
        Err(StateError::Overlap) => return 4,
        Err(StateError::Range) => return 5,
        Err(StateError::Shape) => return 0,
    }
    with_slot(slot, |s| {
        let mut sim = Integrator::new(state, method, dt);
        sim.tolerance = tolerance;
        s.sim = Some(sim);
        1
    })
    .unwrap_or(0)
}

/// 時刻 t まで進める
#[unsafe(no_mangle)]
pub extern "C" fn sim_advance(slot: u32, t: f64) {
    with_slot(slot, |s| {
        if let Some(sim) = s.sim.as_mut() {
            sim.advance_to(t);
        }
    });
}

/// 記録する時刻を書き込む配列のアドレス（RECORD_CAPACITY 個。長さは変えないので、アドレスは変わらない）
#[unsafe(no_mangle)]
pub extern "C" fn sim_times() -> *mut f64 {
    TIMES.with(|cell| cell.borrow_mut().as_mut_ptr())
}

/// 時刻 until まで進め、sim_times の先頭 n 個の時刻（昇順）の状態を記録する（軌跡の記録。刻みは sim_advance と同じで、
/// 記録する時刻で刻みを切らない。Integrator::advance_recording）。記録した数を返す（n が RECORD_CAPACITY を超える、
/// 計算器がないときは 0 で、何もしない）
#[unsafe(no_mangle)]
pub extern "C" fn sim_advance_recording(slot: u32, until: f64, n: u32) -> u32 {
    let n = n as usize;
    if n > RECORD_CAPACITY {
        return 0;
    }
    let times = TIMES.with(|cell| cell.borrow()[..n].to_vec());
    with_slot(slot, |s| {
        let Some(sim) = s.sim.as_mut() else {
            return 0;
        };
        s.samples = sim.advance_recording(until, &times);
        s.samples.len() as u32
    })
    .unwrap_or(0)
}

/// 記録した j 番目の状態の位置（天体ごとの x, y, z）を書き出した配列のアドレス（sim_positions と同じ配列。記録がなければ NaN）
#[unsafe(no_mangle)]
pub extern "C" fn sim_sample_positions(slot: u32, j: u32) -> *const f64 {
    with_slot(slot, |s| {
        match s.samples.get(j as usize) {
            Some(state) => write_vectors(&mut s.out, &state.positions),
            None => s.out.fill(f64::NAN),
        }
        s.out.as_ptr()
    })
    .unwrap_or(std::ptr::null())
}

/// 記録した j 番目の状態の速度（sim_velocities と同じ配列。記録がなければ NaN）
#[unsafe(no_mangle)]
pub extern "C" fn sim_sample_velocities(slot: u32, j: u32) -> *const f64 {
    with_slot(slot, |s| {
        match s.samples.get(j as usize) {
            Some(state) => write_vectors(&mut s.vout, &state.velocities),
            None => s.vout.fill(f64::NAN),
        }
        s.vout.as_ptr()
    })
    .unwrap_or(std::ptr::null())
}

/// 記録した j 番目の状態の重心の成分（記録がなければ NaN）
#[unsafe(no_mangle)]
pub extern "C" fn sim_sample_com(slot: u32, j: u32, component: u32) -> f64 {
    with_slot(slot, |s| {
        s.samples
            .get(j as usize)
            .map(|state| axis(state.center_of_mass(), component))
    })
    .flatten()
    .unwrap_or(f64::NAN)
}

fn read(slot: u32, f: impl FnOnce(&Integrator) -> f64) -> f64 {
    with_slot(slot, |s| s.sim.as_ref().map(f))
        .flatten()
        .unwrap_or(f64::NAN)
}

fn axis(v: Vec3, axis: u32) -> f64 {
    match axis {
        0 => v.x,
        1 => v.y,
        _ => v.z,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_time(slot: u32) -> f64 {
    read(slot, |s| s.time)
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_energy(slot: u32) -> f64 {
    read(slot, |s| s.state.energy())
}

/// 全角運動量の成分（axis：0 = x、1 = y、2 = z）
#[unsafe(no_mangle)]
pub extern "C" fn sim_angular_momentum(slot: u32, component: u32) -> f64 {
    read(slot, |s| axis(s.state.angular_momentum(), component))
}

#[unsafe(no_mangle)]
pub extern "C" fn sim_steps(slot: u32) -> f64 {
    read(slot, |s| s.steps as f64)
}

/// 現在の刻み幅（RK45 では自動で変わる）
#[unsafe(no_mangle)]
pub extern "C" fn sim_dt(slot: u32) -> f64 {
    read(slot, |s| s.dt)
}

/// 重心の成分（表示の中心に使う）
#[unsafe(no_mangle)]
pub extern "C" fn sim_com(slot: u32, component: u32) -> f64 {
    read(slot, |s| axis(s.state.center_of_mass(), component))
}

/// 位置（天体ごとの x, y, z）を書き出した配列のアドレス
#[unsafe(no_mangle)]
pub extern "C" fn sim_positions(slot: u32) -> *const f64 {
    with_slot(slot, |s| {
        if let Some(sim) = s.sim.as_ref() {
            write_vectors(&mut s.out, &sim.state.positions);
        }
        s.out.as_ptr()
    })
    .unwrap_or(std::ptr::null())
}

/// 速度（天体ごとの vx, vy, vz）を書き出した配列のアドレス（回転座標系の向きを決めるのに使う）
#[unsafe(no_mangle)]
pub extern "C" fn sim_velocities(slot: u32) -> *const f64 {
    with_slot(slot, |s| {
        if let Some(sim) = s.sim.as_ref() {
            write_vectors(&mut s.vout, &sim.state.velocities);
        }
        s.vout.as_ptr()
    })
    .unwrap_or(std::ptr::null())
}

fn write_vectors(out: &mut [f64; MAX_BODIES * 3], vectors: &[Vec3]) {
    for (i, p) in vectors.iter().enumerate().take(MAX_BODIES) {
        out[3 * i] = p.x;
        out[3 * i + 1] = p.y;
        out[3 * i + 2] = p.z;
    }
}

/// ラグランジュ点 L(k+1)（k = 0〜4）の成分（scenarios::lagrange_points。主星と伴星の間隔を 1 とした回転座標系）
#[unsafe(no_mangle)]
pub extern "C" fn sim_lagrange(mu: f64, k: u32, component: u32) -> f64 {
    scenarios::lagrange_points(mu)
        .get(k as usize)
        .map_or(f64::NAN, |p| axis(*p, component))
}
