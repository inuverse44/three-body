//! シナリオ（docs/plan.md §2）。平面のものは z = 0。出典はユーザーが示した資料と、docs/plan.md の各シナリオの出典

use crate::{State, Vec3};

/// S-01 8 の字の解（Chenciner & Montgomery 2000。初期値は Simó による）
pub const FIGURE_EIGHT_PERIOD: f64 = 6.325_913_98;

pub fn figure_eight() -> State {
    let x1 = Vec3::new(-0.970_004_36, 0.243_087_53, 0.0);
    let v3 = Vec3::new(-0.932_407_37, -0.864_731_46, 0.0);
    State {
        masses: vec![1.0, 1.0, 1.0],
        positions: vec![x1, x1 * -1.0, Vec3::default()],
        velocities: vec![v3 * -0.5, v3 * -0.5, v3],
    }
}

/// S-02 ピタゴラスの三体問題（Burrau 1913）。質量 3・4・5 を、3・4・5 の直角三角形の頂点に静止させる
pub fn pythagorean() -> State {
    State {
        masses: vec![3.0, 4.0, 5.0],
        positions: vec![
            Vec3::new(1.0, 3.0, 0.0),
            Vec3::new(-2.0, -1.0, 0.0),
            Vec3::new(1.0, -1.0, 0.0),
        ],
        velocities: vec![Vec3::default(); 3],
    }
}

/// S-06 8 の字の解の天体 1 に、平面に垂直な速度 v_z = 0.1 を足したもの（3 次元の軌道になる）
pub fn figure_eight_vertical() -> State {
    let mut s = figure_eight();
    s.velocities[0].z += 0.1;
    // 全運動量を 0 に保つため、ほかの 2 天体に半分ずつ逆向きに配る
    s.velocities[1].z -= 0.05;
    s.velocities[2].z -= 0.05;
    s
}

/// S-07 傾いた階層的三体：質量 1・1 の連星（間隔 1、xy 平面の円軌道）の周りを、
/// 質量 0.1 の天体が半径 5 の円軌道で、xy 平面から 30° 傾いて回る。全運動量は 0
pub fn hierarchical_inclined() -> State {
    let inclination = 30f64.to_radians();
    let inner = (2.0f64).sqrt() / 2.0; // 連星の各天体の速さ（間隔 1、全質量 2）
    let outer = (2.1f64 / 5.0).sqrt(); // 第 3 天体の円軌道の速さ（全質量 2.1、半径 5）
    let v3 = Vec3::new(0.0, outer * inclination.cos(), outer * inclination.sin());
    let m3 = 0.1;
    // 連星の重心が第 3 天体と逆向きに動くようにして、全運動量を 0 にする
    let drift = v3 * (-m3 / 2.0);
    let r3 = Vec3::new(5.0, 0.0, 0.0);
    let shift = r3 * (-m3 / 2.0); // 全体の重心を原点に置く
    State {
        masses: vec![1.0, 1.0, m3],
        positions: vec![
            Vec3::new(-0.5, 0.0, 0.0) + shift,
            Vec3::new(0.5, 0.0, 0.0) + shift,
            r3 + shift,
        ],
        velocities: vec![
            Vec3::new(0.0, -inner, 0.0) + drift,
            Vec3::new(0.0, inner, 0.0) + drift,
            v3,
        ],
    }
}

/// 二体問題の円軌道（検証 V-01 用）。質量 1 の 2 天体が、間隔 1 で互いの周りを回る
pub fn circular_binary() -> State {
    // 間隔 r = 1、全質量 M = 2 の円軌道の相対速度は sqrt(M / r)
    let v = (2.0f64).sqrt() / 2.0;
    State {
        masses: vec![1.0, 1.0],
        positions: vec![Vec3::new(-0.5, 0.0, 0.0), Vec3::new(0.5, 0.0, 0.0)],
        velocities: vec![Vec3::new(0.0, -v, 0.0), Vec3::new(0.0, v, 0.0)],
    }
}

/// 円軌道の周期：T = 2π sqrt(r³ / M)
pub const CIRCULAR_BINARY_PERIOD: f64 = std::f64::consts::PI * std::f64::consts::SQRT_2;

/// S-03 カオス：初期位置の 1 つを `epsilon` だけずらしたもの
pub fn perturbed(mut state: State, epsilon: f64) -> State {
    state.positions[0].x += epsilon;
    state
}

/// 重心を原点に置き、全運動量を 0 にする
fn centered(mut s: State) -> State {
    let total: f64 = s.masses.iter().sum();
    let (c, v) = (s.center_of_mass(), s.momentum() * (1.0 / total));
    for i in 0..s.len() {
        s.positions[i] = s.positions[i] - c;
        s.velocities[i] = s.velocities[i] - v;
    }
    s
}

/// 質量 m1・m2 の 2 体が、軌道長半径 a・離心率 e の楕円軌道の近点にいるときの、2 体の重心から見た位置と速度。
/// 2 体は x 軸の上（m1 が負の側）に並び、xy 平面を反時計回りに回る
fn kepler_pair(m1: f64, m2: f64, a: f64, e: f64) -> ([Vec3; 2], [Vec3; 2]) {
    let m = m1 + m2;
    let r = a * (1.0 - e);
    let v = (m * (1.0 + e) / r).sqrt(); // 近点での相対速度（活力の式）
    (
        [
            Vec3::new(-r * m2 / m, 0.0, 0.0),
            Vec3::new(r * m1 / m, 0.0, 0.0),
        ],
        [
            Vec3::new(0.0, -v * m2 / m, 0.0),
            Vec3::new(0.0, v * m1 / m, 0.0),
        ],
    )
}

/// z 軸の周りに angle（ラジアン）だけ回す
fn rotate_z(v: Vec3, angle: f64) -> Vec3 {
    let (s, c) = angle.sin_cos();
    Vec3::new(v.x * c - v.y * s, v.x * s + v.y * c, v.z)
}

/// S-08 Šuvakov & Dmitrašinović (2013) の周期解。等質量、角運動量 0。
/// x1 = −x2 = (−1, 0)、x3 = 0、v1 = v2 = (vx, vy)、v3 = −2 v1
#[derive(Clone, Copy, Debug)]
pub struct PlanarOrbit {
    pub vx: f64,
    pub vy: f64,
    pub period: f64,
}

/// 蝶 I（I.A.1）。15 桁の値は Li & Liao（arXiv:1312.6796）による
pub const BUTTERFLY_I: PlanarOrbit = PlanarOrbit {
    vx: 0.306_892_758_965_492,
    vy: 0.125_506_782_829_762,
    period: 6.235_641_363_164_79,
};
/// 蛾 I（I.B.1）。値は Šuvakov & Dmitrašinović の表の 5 桁
pub const MOTH_I: PlanarOrbit = PlanarOrbit {
    vx: 0.464_44,
    vy: 0.396_06,
    period: 14.893_9,
};
/// 陰陽 I（II.C.2a）。15 桁の値は Li & Liao による
pub const YIN_YANG_I: PlanarOrbit = PlanarOrbit {
    vx: 0.513_938_054_919_243,
    vy: 0.304_736_003_875_733,
    period: 17.328_369_755_004,
};
/// トンボ（I.B.7）。15 桁の値は Li & Liao による
pub const DRAGONFLY: PlanarOrbit = PlanarOrbit {
    vx: 0.080_584_285_736_084,
    vy: 0.588_836_087_036_132,
    period: 21.270_975_196_664_8,
};

pub fn suvakov(orbit: PlanarOrbit) -> State {
    let v = Vec3::new(orbit.vx, orbit.vy, 0.0);
    State {
        masses: vec![1.0, 1.0, 1.0],
        positions: vec![
            Vec3::new(-1.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::default(),
        ],
        velocities: vec![v, v, v * -2.0],
    }
}

/// S-09 ラグランジュの正三角形の解：質量 1 の 3 天体が、辺 1 の正三角形のまま角速度 √3 で回る。
/// 等質量では不安定（Routh の条件を満たさない）なので、数値計算の丸め誤差だけで崩れる
pub fn lagrange_triangle() -> State {
    let r = 1.0 / 3f64.sqrt(); // 外接円の半径
    let mut s = State {
        masses: vec![1.0; 3],
        positions: vec![],
        velocities: vec![],
    };
    for k in 0..3 {
        let a = std::f64::consts::FRAC_PI_2 + std::f64::consts::TAU * k as f64 / 3.0;
        s.positions.push(Vec3::new(r * a.cos(), r * a.sin(), 0.0));
        // 速さ ωr = √3 · (1/√3) = 1
        s.velocities.push(Vec3::new(-a.sin(), a.cos(), 0.0));
    }
    s
}

/// 木星と太陽の質量の比（IAU 2015 Resolution B3 の公称値 GM から）
pub const JUPITER_SUN_MASS_RATIO: f64 = 9.546e-4;

/// 太陽・木星の伴星の割合 μ = m_J / (m_S + m_J)
pub const JUPITER_MU: f64 = JUPITER_SUN_MASS_RATIO / (1.0 + JUPITER_SUN_MASS_RATIO);

/// S-10 主星（質量 1 − μ）と伴星（質量 μ）が間隔 1 の円軌道を回り、ラグランジュ点 L4（両者と正三角形をなす点）に
/// ごく軽い天体（質量 1e-9）を置く。Routh の条件から、μ < 約 0.0385 なら L4 にとどまる
pub fn trojan(mu: f64) -> State {
    trojan_displaced(mu, 0.0)
}

/// S-16 L4 の天体を、主星と伴星の重心の周りに angle_deg だけ前（伴星から遠ざかる向き）へ回した位置に置き、
/// 2 天体と同じ角速度で回る速度を与える。回転座標系では、はじめ止まっていて、L4 の周りを揺れはじめる
pub fn trojan_displaced(mu: f64, angle_deg: f64) -> State {
    let (m1, m2) = (1.0 - mu, mu);
    let ([p1, p2], [v1, v2]) = kepler_pair(m1, m2, 1.0, 0.0);
    // 角速度 ω = 1（全質量 1、間隔 1）で、2 天体の重心の周りを剛体のように回る
    let p = rotate_z(
        Vec3::new(p1.x + 0.5, 3f64.sqrt() / 2.0, 0.0),
        angle_deg.to_radians(),
    );
    centered(State {
        masses: vec![m1, m2, 1e-9],
        positions: vec![p1, p2, p],
        velocities: vec![v1, v2, Vec3::new(-p.y, p.x, 0.0)],
    })
}

/// S-16 オタマジャクシ軌道：L4 から 20° ずらす（伴星から見て 44°〜80° のあいだを揺れる）
pub const TADPOLE_ANGLE_DEG: f64 = 20.0;
/// S-16 馬蹄形軌道：L4 から 115° ずらす（L3 の近くから始まり、L4・L3・L5 をまたいで往復する）
pub const HORSESHOE_ANGLE_DEG: f64 = 115.0;

/// 円制限三体問題のラグランジュ点 L1〜L5。主星（質量の割合 1 − μ）と伴星（μ）の間隔を 1、
/// 2 天体の重心を原点、伴星を +x 軸の上（主星は −μ、伴星は 1 − μ）、公転の向きを +z とした回転座標系での位置。
/// L1（2 天体のあいだ）・L2（伴星の外側）・L3（主星の外側）は、x 軸の上で有効ポテンシャルの勾配が 0 になる点を、
/// 浮動小数点数で表せる精度まで二分法で求める。
/// L4・L5 は 2 天体と正三角形をなす点（L4 が公転の向きに伴星の前）
pub fn lagrange_points(mu: f64) -> [Vec3; 5] {
    let (x1, x2) = (-mu, 1.0 - mu);
    // x 軸の上の、有効ポテンシャルの勾配の x 成分（遠心力 + 2 天体の引力）
    let force = |x: f64| {
        let (d1, d2) = (x - x1, x - x2);
        x - (1.0 - mu) * d1 / d1.abs().powi(3) - mu * d2 / d2.abs().powi(3)
    };
    // 区間 (lo, hi) の根。3 つの区間とも、force は lo の側で負、hi の側で正になる
    // （L1：主星の右で −∞、伴星の左で +∞。L2：伴星の右で −∞、遠くで +∞。L3：遠くで −∞、主星の左で +∞）。
    // 端は天体の位置そのものにして、force を端で計算せずに、両端が隣り合う浮動小数点数になるまで二分する。
    // 天体から決まった幅だけ離した区間では、μ が小さいとき（L1・L2 は伴星から (μ/3)^(1/3)）に解を外す
    // 最後は、勾配の小さいほうの端を返す（端が天体の位置のままなら勾配は NaN なので、そちらは選ばない）。
    // μ が NaN でも止まるよう、回数に上限を設ける（幅 3 の区間を、非正規化数の刻みまで半分にしても足りる回数）
    let size = |x: f64| {
        let f = force(x).abs();
        if f.is_nan() { f64::INFINITY } else { f }
    };
    let root = |mut lo: f64, mut hi: f64| {
        for _ in 0..2200 {
            let mid = 0.5 * (lo + hi);
            if mid <= lo || mid >= hi {
                break;
            }
            if force(mid) > 0.0 {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        if size(hi) < size(lo) { hi } else { lo }
    };
    let h = 3f64.sqrt() / 2.0;
    [
        Vec3::new(root(x1, x2), 0.0, 0.0),
        Vec3::new(root(x2, x2 + 2.0), 0.0, 0.0),
        Vec3::new(root(x1 - 2.0, x1), 0.0, 0.0),
        Vec3::new(0.5 - mu, h, 0.0),
        Vec3::new(0.5 - mu, -h, 0.0),
    ]
}

/// S-11 オイラーの一直線の解：質量 1 の 3 天体が間隔 1 で一直線に並んで回る（ω² = 5/4）。
/// 不安定だが、対称なままでは丸め誤差が育たないので、中央の天体を 1e-9 だけずらす（重心のずれは 3e-10 なので直さない）
pub fn euler_collinear() -> State {
    let v = 1.25f64.sqrt();
    State {
        masses: vec![1.0; 3],
        positions: vec![
            Vec3::new(-1.0, 0.0, 0.0),
            Vec3::new(1e-9, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
        ],
        velocities: vec![
            Vec3::new(0.0, -v, 0.0),
            Vec3::default(),
            Vec3::new(0.0, v, 0.0),
        ],
    }
}

/// S-12 Kepler-16（Doyle et al. 2011 の表 1）。単位は太陽質量・AU（時間の単位は 1 年 / 2π ≈ 58.1 日）。
/// 2 つの星（0.6897、0.20255）は a = 0.22431 AU、e = 0.15944 の軌道の近点から、
/// 惑星（木星の 0.333 倍）は 2 つの星の重心の周りの半径 `planet_a` の円軌道から始める。軌道は同じ平面に簡略化する
pub fn kepler16(planet_a: f64) -> State {
    let (ma, mb) = (0.6897, 0.20255);
    let mp = 0.333 * JUPITER_SUN_MASS_RATIO;
    let ([pa, pb], [va, vb]) = kepler_pair(ma, mb, 0.22431, 0.15944);
    let vp = ((ma + mb) / planet_a).sqrt();
    centered(State {
        masses: vec![ma, mb, mp],
        positions: vec![pa, pb, Vec3::new(0.0, planet_a, 0.0)],
        velocities: vec![va, vb, Vec3::new(-vp, 0.0, 0.0)],
    })
}

/// Kepler-16 の惑星の実際の軌道長半径（AU）
pub const KEPLER16_PLANET_A: f64 = 0.7048;
/// 安定限界（Holman & Wiegert 1999 の式で約 0.65 AU）の内側に置いた惑星の軌道長半径（AU）
pub const KEPLER16_INNER_A: f64 = 0.5;

/// S-13 古在・リドフ振動：質量 1 の星の周りを質量 0.001 の惑星が a = 1、e = 0.05 で回り、
/// 質量 1 の星が半径 5 の円軌道で、惑星の軌道面から `inclination_deg` 度傾いて回る。
/// 傾きが約 39.2° を超えると、惑星の離心率と傾きが周期的に入れ替わる
pub fn kozai_lidov(inclination_deg: f64) -> State {
    let ([p1, p2], [v1, v2]) = kepler_pair(1.0, 0.001, 1.0, 0.05);
    let i = inclination_deg.to_radians();
    let a_out = 5.0;
    let v_out = (2.001f64 / a_out).sqrt();
    centered(State {
        masses: vec![1.0, 0.001, 1.0],
        positions: vec![p1, p2, Vec3::new(a_out, 0.0, 0.0)],
        velocities: vec![v1, v2, Vec3::new(0.0, v_out * i.cos(), v_out * i.sin())],
    })
}

/// 古在・リドフ振動のプリセットの傾き（度）
pub const KOZAI_INCLINATION_DEG: f64 = 75.0;

/// S-14 連星への侵入：質量 1・1 の連星（間隔 1、円軌道、z 軸の周りに `phase` ラジアン回した位置から）に、
/// 質量 1 の天体が x = −15 から、連星の重心を通る直線から y 方向に `offset` だけずれた直線に沿って飛び込む
/// （`offset` は距離 15 での横のずれで、無限遠での衝突径数とは違う）。無限遠での相対速度は臨界速度 v_c の `speed` 倍
/// （v_c は全エネルギーが 0 になる速さ。等質量では v_c² = 3/2）。
/// 全エネルギーが、連星の結合エネルギー −1/2 と無限遠での相対運動のエネルギー (1/2)(2/3) v_inf²（換算質量 2/3）の和に
/// 一致するよう、距離 15 での速さを、実際の位置の位置エネルギーと連星の反跳を含めて逆算する
pub fn binary_intruder(speed: f64, offset: f64, phase: f64) -> State {
    let ([p1, p2], [v1, v2]) = kepler_pair(1.0, 1.0, 1.0, 0.0);
    let reduced_mass = 2.0 / 3.0;
    let v_inf = speed * 1.5f64.sqrt();
    let target = -0.5 + 0.5 * reduced_mass * v_inf * v_inf;
    let build = |v: f64| {
        centered(State {
            masses: vec![1.0, 1.0, 1.0],
            positions: vec![
                rotate_z(p1, phase),
                rotate_z(p2, phase),
                Vec3::new(-15.0, offset, 0.0),
            ],
            velocities: vec![
                rotate_z(v1, phase),
                rotate_z(v2, phase),
                Vec3::new(v, 0.0, 0.0),
            ],
        })
    };
    // 侵入天体の速さ v は、重心系では連星との相対速度になり、運動エネルギーを (1/2)(2/3) v² だけ増やす
    let at_rest = build(0.0).energy();
    build((2.0 * (target - at_rest) / reduced_mass).sqrt())
}

/// 入れ替わり：遅く飛び込んだ天体 3 が天体 1 と連星を作り、天体 2 が弾き出される
pub fn binary_exchange() -> State {
    binary_intruder(0.6, 0.3, 0.0)
}

/// ばらばら：臨界速度の 2 倍で飛び込み、全エネルギーが正なので 3 つとも離れていく
pub fn binary_ionization() -> State {
    binary_intruder(2.0, 0.0, 0.0)
}

/// S-15 シトニコフ問題：質量 0.5・0.5 の連星（a = 1、e = 0.1）の重心を通り軌道面に垂直な軸（z 軸）の上に、
/// ごく軽い天体（質量 1e-9）を z = 1 に静止させて置く。軽い天体は軸の上を上下に振動する。
/// 重心のずれ（z 方向に 1e-9）は運動に効かないので、入力欄の値が 1 のままになるよう、重心をそろえない
pub fn sitnikov() -> State {
    let ([p1, p2], [v1, v2]) = kepler_pair(0.5, 0.5, 1.0, 0.1);
    State {
        masses: vec![0.5, 0.5, 1e-9],
        positions: vec![p1, p2, Vec3::new(0.0, 0.0, 1.0)],
        velocities: vec![v1, v2, Vec3::default()],
    }
}

/// シナリオ番号から状態を作る（WebAssembly の窓口用）
pub fn by_id(id: u32) -> Option<State> {
    match id {
        0 => Some(figure_eight()),
        1 => Some(pythagorean()),
        2 => Some(figure_eight_vertical()),
        3 => Some(hierarchical_inclined()),
        4 => Some(suvakov(BUTTERFLY_I)),
        5 => Some(suvakov(MOTH_I)),
        6 => Some(suvakov(YIN_YANG_I)),
        7 => Some(suvakov(DRAGONFLY)),
        8 => Some(lagrange_triangle()),
        9 => Some(trojan(JUPITER_MU)),
        10 => Some(trojan(0.05)),
        11 => Some(euler_collinear()),
        12 => Some(kepler16(KEPLER16_PLANET_A)),
        13 => Some(kepler16(KEPLER16_INNER_A)),
        14 => Some(kozai_lidov(KOZAI_INCLINATION_DEG)),
        15 => Some(binary_exchange()),
        16 => Some(binary_ionization()),
        17 => Some(sitnikov()),
        18 => Some(trojan_displaced(JUPITER_MU, TADPOLE_ANGLE_DEG)),
        19 => Some(trojan_displaced(JUPITER_MU, HORSESHOE_ANGLE_DEG)),
        _ => None,
    }
}

/// プリセットの最初の刻み幅（画面の「刻み幅 h」の既定。RK45 では最初に試す刻み幅）。
/// 天体が強く接近するもの（ピタゴラス、崩れたあと接近をくり返す正三角形とオイラーの解、内側に置いた惑星、
/// 古在・リドフ、連星への侵入 2 つ）は細かくする
pub fn preset_dt(id: u32) -> f64 {
    match id {
        1 | 8 | 11 | 13..=16 => 0.001,
        _ => 0.01,
    }
}

/// プリセットの数（by_id が Some を返す番号は 0..PRESET_COUNT）
pub const PRESET_COUNT: u32 = 20;
