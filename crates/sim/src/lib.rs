//! 三体問題（N 体問題）の数値計算（docs/plan.md §3）。重力定数 G = 1 の無次元の単位で、3 次元の運動を扱う。
//! 外部クレートは使わない（C-01）。

// 数値計算では、添字のループのほうが式（a_i、m_j など）と対応して読みやすいので許可する
#![allow(clippy::needless_range_loop)]

pub mod integrators;
pub mod scenarios;
#[cfg(target_arch = "wasm32")]
mod wasm;

/// 3 次元のベクトル
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
    pub fn dot(self, o: Self) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: Self) -> Self {
        Self::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }
}

impl std::ops::Add for Vec3 {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl std::ops::Sub for Vec3 {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl std::ops::Mul<f64> for Vec3 {
    type Output = Self;
    fn mul(self, k: f64) -> Self {
        Self::new(self.x * k, self.y * k, self.z * k)
    }
}

/// 扱える天体の数の上限（色の見分けやすさを検証した配色が 8 色のため）
pub const MAX_BODIES: usize = 8;

/// 計算できる値の範囲（docs/plan.md §3：N-07）。質量の下限と上限
pub const MIN_MASS: f64 = 1e-12;
pub const MAX_MASS: f64 = 1e12;
/// 位置と速度の各成分の絶対値の上限
pub const MAX_COMPONENT: f64 = 1e6;
/// 2 天体の間隔の下限（これより近いと重なっているとみなす）
pub const MIN_SEPARATION: f64 = 1e-9;

/// 入力の誤り（S-05）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateError {
    /// 天体の数が 2〜MAX_BODIES の外か、配列の長さが合わない
    Shape,
    /// 質量が正の有限の数でない
    Mass,
    /// 位置や速度に、有限でない数がある
    NotFinite,
    /// 位置や速度の成分の絶対値が MAX_COMPONENT より大きい
    Range,
    /// 2 つの天体が同じ位置にある
    Overlap,
}

/// 天体の集まりの状態（位置と速度）
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub masses: Vec<f64>,
    pub positions: Vec<Vec3>,
    pub velocities: Vec<Vec3>,
}

impl State {
    pub fn len(&self) -> usize {
        self.masses.len()
    }

    pub fn is_empty(&self) -> bool {
        self.masses.is_empty()
    }

    /// N-01 各天体の加速度（万有引力、G = 1、軟化なし）
    pub fn accelerations(&self, positions: &[Vec3]) -> Vec<Vec3> {
        let n = self.len();
        let mut acc = vec![Vec3::default(); n];
        for i in 0..n {
            for j in (i + 1)..n {
                let d = positions[j] - positions[i];
                let r2 = d.dot(d);
                let inv_r3 = 1.0 / (r2 * r2.sqrt());
                acc[i] = acc[i] + d * (self.masses[j] * inv_r3);
                acc[j] = acc[j] - d * (self.masses[i] * inv_r3);
            }
        }
        acc
    }

    /// N-05 全エネルギー（運動エネルギー＋位置エネルギー）
    pub fn energy(&self) -> f64 {
        let n = self.len();
        let kinetic: f64 = (0..n)
            .map(|i| 0.5 * self.masses[i] * self.velocities[i].dot(self.velocities[i]))
            .sum();
        let mut potential = 0.0;
        for i in 0..n {
            for j in (i + 1)..n {
                potential -= self.masses[i] * self.masses[j]
                    / (self.positions[j] - self.positions[i]).norm();
            }
        }
        kinetic + potential
    }

    /// N-05 全運動量
    pub fn momentum(&self) -> Vec3 {
        (0..self.len()).fold(Vec3::default(), |p, i| {
            p + self.velocities[i] * self.masses[i]
        })
    }

    /// N-05 全角運動量（ベクトル）：L = Σ m_i r_i × v_i
    pub fn angular_momentum(&self) -> Vec3 {
        (0..self.len()).fold(Vec3::default(), |l, i| {
            l + self.positions[i].cross(self.velocities[i]) * self.masses[i]
        })
    }

    /// 入力の検証（S-05、N-07）：天体は 2〜MAX_BODIES 個、質量は MIN_MASS〜MAX_MASS、位置と速度は有限で各成分の絶対値が
    /// MAX_COMPONENT 以下、どの 2 天体の間隔も MIN_SEPARATION 以上
    pub fn validate(&self) -> Result<(), StateError> {
        let n = self.len();
        if !(2..=MAX_BODIES).contains(&n) || self.positions.len() != n || self.velocities.len() != n
        {
            return Err(StateError::Shape);
        }
        if self
            .masses
            .iter()
            .any(|m| !(MIN_MASS..=MAX_MASS).contains(m))
        {
            return Err(StateError::Mass);
        }
        let vectors = || self.positions.iter().chain(&self.velocities);
        let components = |v: &Vec3| [v.x, v.y, v.z];
        if !vectors().flat_map(components).all(f64::is_finite) {
            return Err(StateError::NotFinite);
        }
        if vectors()
            .flat_map(components)
            .any(|c| c.abs() > MAX_COMPONENT)
        {
            return Err(StateError::Range);
        }
        for i in 0..n {
            for j in (i + 1)..n {
                if (self.positions[j] - self.positions[i]).norm() < MIN_SEPARATION {
                    return Err(StateError::Overlap);
                }
            }
        }
        Ok(())
    }

    /// 重心（N-08）。質量の和は、あふれたり 0 に落ちたりするので、各質量を最大の質量で割った比から求める。
    /// 位置は成分ごとに、絶対値の最大で割ってから足す（極大の位置の和があふれないように）。重心は位置の凸結合なので、
    /// 重みの和の丸めで外れた分は、各成分を位置の最小と最大の間に収めて直す。有限でない位置があれば、その成分は NaN
    pub fn center_of_mass(&self) -> Vec3 {
        let largest = self.masses.iter().fold(0.0_f64, |a, &m| a.max(m));
        let weights: Vec<f64> = self.masses.iter().map(|m| m / largest).collect();
        let total: f64 = weights.iter().sum();
        let component = |get: fn(&Vec3) -> f64| {
            let values: Vec<f64> = self.positions.iter().map(get).collect();
            if !values.iter().all(|v| v.is_finite()) {
                return f64::NAN;
            }
            let scale = values.iter().fold(0.0_f64, |a, v| a.max(v.abs()));
            if scale == 0.0 {
                return 0.0;
            }
            let mean = values
                .iter()
                .zip(&weights)
                .map(|(v, w)| v / scale * (w / total))
                .sum::<f64>()
                * scale;
            let lo = values.iter().fold(f64::INFINITY, |a, &v| a.min(v));
            let hi = values.iter().fold(f64::NEG_INFINITY, |a, &v| a.max(v));
            mean.max(lo).min(hi)
        };
        Vec3::new(component(|p| p.x), component(|p| p.y), component(|p| p.z))
    }
}
