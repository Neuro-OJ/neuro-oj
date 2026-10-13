// prediction 分派判定的纯函数契约测试（Task 9）。
//
// `evaluate_with_cpu_limit` 是评测任务的唯一入口，依据 `submission_mode` 选择：
//   - "prediction" → 单容器数据评分路径（`prediction::evaluate_prediction`）；
//   - 其他值（含历史缺省 "code" / "artifact"）→ 既有双容器路径。
//
// 分派判定抽成纯函数 `is_prediction_mode`，这里只断言判定语义，不触碰 Docker。

use noj_judge::judge::runner::is_prediction_mode;

#[test]
fn dispatch_target_prediction_for_prediction_mode() {
    assert!(
        is_prediction_mode("prediction"),
        "submission_mode=prediction 必须选中 prediction 单容器路径"
    );
}

#[test]
fn dispatch_target_dual_for_non_prediction_modes() {
    for mode in ["code", "artifact", "", "PREDICTION", "prediction "] {
        assert!(
            !is_prediction_mode(mode),
            "submission_mode={mode:?} 必须走既有双容器路径"
        );
    }
}
