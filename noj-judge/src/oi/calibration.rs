//! OI 后端的硬件校准模型。
//!
//! 校准只拟合“参考工作量 → 当前 Worker 时间”的可解释关系，不接受题目提交的
//! 任意模型文件，也不把单次评测的噪声直接写回题目限制。调用方应在 Worker
//! 配置变更或维护窗口中用固定基准样本重新拟合并持久化结果。

#![allow(dead_code)]

use anyhow::{bail, Result};

/// 一条基准样本。`reference_work` 可以是固定指令数、基准输入规模或基准机耗时，
/// 但同一份模型中的所有样本必须使用同一种定义。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibrationSample {
    pub reference_work: f64,
    pub observed_time_ms: f64,
}

/// 透明的线性校准模型：`time_ms = slope * reference_work + intercept`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CalibrationModel {
    pub slope: f64,
    pub intercept: f64,
    pub residual_rmse_ms: f64,
    pub sample_count: usize,
}

impl CalibrationModel {
    /// 用最小二乘法拟合基准样本，并拒绝非有限、非正和退化样本。
    pub fn fit(samples: &[CalibrationSample]) -> Result<Self> {
        if samples.len() < 2 {
            bail!("硬件校准至少需要两个基准样本");
        }
        if samples.iter().any(|sample| {
            !sample.reference_work.is_finite()
                || !sample.observed_time_ms.is_finite()
                || sample.reference_work <= 0.0
                || sample.observed_time_ms <= 0.0
        }) {
            bail!("硬件校准样本必须是有限的正数");
        }
        let n = samples.len() as f64;
        let mean_x = samples
            .iter()
            .map(|sample| sample.reference_work)
            .sum::<f64>()
            / n;
        let mean_y = samples
            .iter()
            .map(|sample| sample.observed_time_ms)
            .sum::<f64>()
            / n;
        let denominator = samples
            .iter()
            .map(|sample| (sample.reference_work - mean_x).powi(2))
            .sum::<f64>();
        if denominator <= f64::EPSILON {
            bail!("硬件校准样本的参考工作量不能全部相同");
        }
        let covariance = samples
            .iter()
            .map(|sample| (sample.reference_work - mean_x) * (sample.observed_time_ms - mean_y))
            .sum::<f64>();
        let slope = covariance / denominator;
        let intercept = mean_y - slope * mean_x;
        if !slope.is_finite() || !intercept.is_finite() || slope <= 0.0 {
            bail!("硬件校准拟合结果无效");
        }
        let residual_rmse_ms = (samples
            .iter()
            .map(|sample| {
                let residual =
                    sample.observed_time_ms - (slope * sample.reference_work + intercept);
                residual * residual
            })
            .sum::<f64>()
            / n)
            .sqrt();
        Ok(Self {
            slope,
            intercept,
            residual_rmse_ms,
            sample_count: samples.len(),
        })
    }

    /// 把参考工作量换算为当前 Worker 的等效毫秒数。
    pub fn predict_time_ms(&self, reference_work: f64) -> Result<f64> {
        if !reference_work.is_finite() || reference_work <= 0.0 {
            bail!("参考工作量必须是有限的正数");
        }
        let predicted = self.slope * reference_work + self.intercept;
        if !predicted.is_finite() || predicted <= 0.0 {
            bail!("校准后的时间不是有限的正数");
        }
        Ok(predicted)
    }

    /// 把参考机时间限制换算成当前 Worker 的限制，并向上取整到毫秒。
    pub fn equivalent_limit_ms(&self, reference_time_ms: f64) -> Result<u64> {
        let predicted = self.predict_time_ms(reference_time_ms)?;
        if !reference_time_ms.is_finite() || reference_time_ms <= 0.0 {
            bail!("参考时间必须是有限的正数");
        }
        Ok(predicted.ceil().max(1.0) as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_reference_to_worker_time() {
        let model = CalibrationModel::fit(&[
            CalibrationSample {
                reference_work: 10.0,
                observed_time_ms: 25.0,
            },
            CalibrationSample {
                reference_work: 20.0,
                observed_time_ms: 45.0,
            },
            CalibrationSample {
                reference_work: 30.0,
                observed_time_ms: 65.0,
            },
        ])
        .unwrap();
        assert!((model.slope - 2.0).abs() < 1e-9);
        assert!((model.intercept - 5.0).abs() < 1e-9);
        assert_eq!(model.equivalent_limit_ms(20.0).unwrap(), 45);
        assert!(model.residual_rmse_ms < 1e-9);
    }

    #[test]
    fn rejects_degenerate_samples() {
        assert!(CalibrationModel::fit(&[CalibrationSample {
            reference_work: 1.0,
            observed_time_ms: 1.0,
        }])
        .is_err());
        assert!(CalibrationModel::fit(&[
            CalibrationSample {
                reference_work: 1.0,
                observed_time_ms: 1.0,
            },
            CalibrationSample {
                reference_work: 1.0,
                observed_time_ms: 2.0,
            },
        ])
        .is_err());
    }
}
