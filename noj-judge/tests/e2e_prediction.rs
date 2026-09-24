//! prediction 单容器路径 Docker E2E：合成支持包 + 预测文件 → 隐藏标签算分。
//!
//! 覆盖 `prediction::evaluate_prediction` 的真实全链路：
//! - 只创建 Evaluator 容器，**绝不创建 Solution 容器**（本任务 headline 断言）；
//! - 支持包 zip 注入 `/workspace`（`evaluate.py` + 隐藏标签文件）；
//! - 预测文件注入 `/workspace/prediction/`（`$NOJ_PREDICTION_DIR`）；
//! - `evaluate.py` 输出 `---RESULT---` + `{score, details}` →
//!   `status == "finished"`、`score > 0`、`details.cases[0].hidden == true`。
//!
//! 结构参照 `tests/e2e_dual_container.rs::dual_artifact_zip_injection`：
//! `#[ignore]` + `NOJ_RUN_E2E=1` 守卫 + `#[serial_test::serial]` + 30s 外层超时。
//!
//! 运行：`NOJ_RUN_E2E=1 cargo test --test e2e_prediction -- --ignored --nocapture`

mod common;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use bollard::query_parameters::ListContainersOptionsBuilder;
use bollard::Docker;
use noj_judge::types::{EvaluatorRuntime, RuntimeConfig};
use zip::write::SimpleFileOptions;

/// Solution 容器标签（`dual/container.rs` 创建 solution 时写入）。prediction 路径
/// 下该标签必须始终为空 —— 这是「不创建 Solution 容器」的直接证据。
const SOLUTION_LABEL: &str = "com.noj.judge.dual.solution=true";
/// Evaluator 容器标签；用于证明「轮询确实观测到了评测容器」，避免标签过滤写错时
/// Solution 断言变成永真的空断言。
const EVALUATOR_LABEL: &str = "com.noj.judge.dual.evaluator=true";

/// 评测脚本：读预测文件与隐藏标签算 accuracy，输出 `---RESULT---` + JSON。
///
/// 故意留一条 `1/3` 错误的预测，使 score = 6666（既 > 0，又不同于任何硬编码满分），
/// 从而证明脚本真的读到了两个输入文件并逐条比对。
const EVALUATE_PY: &str = r##"import json
import os
import sys

pred_dir = os.environ["NOJ_PREDICTION_DIR"]
pred_file = os.environ["NOJ_PREDICTION_FILE"]

# 选手预测文件：每行 "case_id,label"
preds = {}
with open(os.path.join(pred_dir, pred_file), "r", encoding="utf-8") as fh:
    for raw in fh:
        line = raw.strip()
        if not line:
            continue
        case_id, label = line.split(",")
        preds[case_id] = int(label)

# 隐藏标签固定放在支持包内的 /workspace
cases = []
correct = 0
with open("/workspace/hidden_labels.jsonl", "r", encoding="utf-8") as fh:
    for raw in fh:
        line = raw.strip()
        if not line:
            continue
        rec = json.loads(line)
        case_id = rec["case_id"]
        ok = preds.get(case_id) == rec["label"]
        if ok:
            correct += 1
        cases.append({
            "case_id": case_id,
            "status": "Accepted" if ok else "WrongAnswer",
            "hidden": True,
        })

total = len(cases)
score = int(10000 * correct / total) if total else 0

# 诊断输出（非结果行）：验证标记前的噪声行不会干扰 payload 捕获
print(json.dumps({"cases": cases}))
sys.stdout.write("---RESULT---\n")
sys.stdout.write(json.dumps({"score": score, "details": {"cases": cases}}) + "\n")
sys.stdout.flush()
"##;

/// 隐藏标签：c1/c3 与预测一致，c2 预测错（labels 为 1，预测为 0）。
const HIDDEN_LABELS: &str = r#"{"case_id":"c1","label":1}
{"case_id":"c2","label":1}
{"case_id":"c3","label":1}
"#;

/// 预测文件内容。
const PREDICTIONS_CSV: &str = "c1,1\nc2,0\nc3,1\n";

/// 构造支持包 zip（`evaluate.py` + 隐藏标签文件）。
fn build_support_zip() -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default();
    zip.start_file("evaluate.py", options).unwrap();
    zip.write_all(EVALUATE_PY.as_bytes()).unwrap();
    zip.start_file("hidden_labels.jsonl", options).unwrap();
    zip.write_all(HIDDEN_LABELS.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

/// 按 label 过滤列出容器 ID（`all: true`，含已退出容器）。
///
/// 返回 `None` 表示 Docker API 瞬时失败（轮询期间不应把它当作「没有容器」）。
async fn list_ids_by_label(docker: &Docker, label: &str) -> Option<Vec<String>> {
    let mut filters = HashMap::new();
    filters.insert("label".to_string(), vec![label.to_string()]);
    let options = ListContainersOptionsBuilder::new()
        .all(true)
        .filters(&filters)
        .build();
    match docker.list_containers(Some(options)).await {
        Ok(containers) => Some(containers.into_iter().filter_map(|c| c.id).collect()),
        Err(e) => {
            eprintln!("[e2e_prediction] list_containers({label}) 失败: {e}");
            None
        }
    }
}

fn prediction_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: "python3 /workspace/evaluate.py".to_string(),
            time_limit_ms: 20_000,
            memory_limit_mb: 256,
            network: None,
            workspace_size_mb: None,
        },
        // prediction 模式明确省略 solution —— 无 Solution 容器。
        solution: None,
    }
}

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn prediction_end_to_end_scores_and_creates_no_solution_container() {
    if !common::is_e2e_enabled() {
        return;
    }
    let docker = common::get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // 基线：测试开始前不应有本标签的残留容器
    let baseline = list_ids_by_label(&docker, SOLUTION_LABEL)
        .await
        .expect("列出 Solution 容器失败（基线）");
    assert!(
        baseline.is_empty(),
        "测试开始前存在 Solution 容器残留: {:?}",
        baseline
    );

    let temp_dir = tempfile::tempdir().unwrap();
    let support_zip_path = temp_dir.path().join("support.zip");
    let prediction_path = temp_dir.path().join("predictions.csv");
    std::fs::write(&support_zip_path, build_support_zip()).unwrap();
    std::fs::write(&prediction_path, PREDICTIONS_CSV).unwrap();

    let submission_id = format!("e2e-prediction-{}", uuid::Uuid::new_v4());
    let runtime_config = prediction_runtime_config();
    let whitelist = vec!["python3".to_string()];

    // 评测期间轮询两种标签：Solution 必须始终为空；Evaluator 必须被观测到。
    let eval_docker = docker.clone();
    let poll_docker = docker.clone();
    let support_zip: PathBuf = support_zip_path;
    let prediction: PathBuf = prediction_path;

    let (eval_handle, solution_seen, evaluator_seen) =
        tokio::time::timeout(Duration::from_secs(30), async move {
            let eval = tokio::spawn(async move {
                noj_judge::prediction::evaluate_prediction(
                    eval_docker,
                    &submission_id,
                    &runtime_config,
                    Some(support_zip.as_path()),
                    prediction.as_path(),
                    "predictions.csv",
                    None,
                    1000,
                    false,
                    "none",
                    "noj-",
                    &whitelist,
                    300_000,
                    512,
                )
                .await
            });

            let mut solution_seen: Vec<String> = Vec::new();
            let mut evaluator_seen = false;
            loop {
                // 先采样再判断结束，保证至少有一次观测机会
                if let Some(ids) = list_ids_by_label(&poll_docker, SOLUTION_LABEL).await {
                    for id in ids {
                        if !solution_seen.contains(&id) {
                            solution_seen.push(id);
                        }
                    }
                }
                if let Some(ids) = list_ids_by_label(&poll_docker, EVALUATOR_LABEL).await {
                    if !ids.is_empty() {
                        evaluator_seen = true;
                    }
                }
                if eval.is_finished() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }

            (eval, solution_seen, evaluator_seen)
        })
        .await
        .expect("评测 30s 外层超时");

    let result = eval_handle
        .await
        .expect("评测任务 panic")
        .expect("评测应正常返回");

    // ── headline 断言：prediction 路径绝不创建 Solution 容器 ──────────────
    assert!(
        solution_seen.is_empty(),
        "prediction 路径创建了 Solution 容器（运行期观测到）: {:?}",
        solution_seen
    );
    let leftover = list_ids_by_label(&docker, SOLUTION_LABEL)
        .await
        .expect("列出 Solution 容器失败（评测后）");
    assert!(
        leftover.is_empty(),
        "prediction 路径残留 Solution 容器: {:?}",
        leftover
    );
    assert!(
        evaluator_seen,
        "轮询未观测到 Evaluator 容器 —— Solution 空断言失去意义（检查标签或评测是否真的运行）"
    );

    // ── 结果断言 ────────────────────────────────────────────────────────
    assert_eq!(
        result.status, "finished",
        "prediction 评测应 finished: {:?}",
        result
    );
    assert!(
        result.score > 0,
        "score 应 > 0（2/3 命中 → 6666）: {:?}",
        result
    );
    assert_eq!(
        result.score, 6666,
        "隐藏标签比对得分应为 6666: {:?}",
        result
    );

    let cases = result.details["cases"]
        .as_array()
        .expect("details.cases 应为数组");
    assert_eq!(cases.len(), 3, "应评测 3 个隐藏用例: {:?}", result.details);
    assert_eq!(
        cases[0]["hidden"],
        serde_json::json!(true),
        "隐藏标记必须透传: {:?}",
        result.details
    );
    assert_eq!(cases[0]["case_id"], "c1");
    assert_eq!(cases[0]["status"], "Accepted");
    assert_eq!(cases[1]["status"], "WrongAnswer");

    // 预测文件确实被注入到 $NOJ_PREDICTION_DIR 下
    assert!(
        result.output.contains("---RESULT---"),
        "output 应包含结果标记: {:?}",
        result.output
    );
}
